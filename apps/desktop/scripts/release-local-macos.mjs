#!/usr/bin/env node
// Local macOS release driver for Sofia App.
//
// Builds, signs, notarizes, staples, publishes a GitHub Release, and mirrors
// the artifacts to an S3-compatible bucket (release.ruut.chat). Intended for
// macOS hosts when CI is unavailable.
//
// Usage:
//   pnpm --filter @sofia/desktop release:local:macos --version 0.1.1
//
// Configuration comes from the environment or an env file (default:
//   ~/.sofia/app-release.env), one KEY=VALUE per line:
//   SOFIA_SOURCE_DIR, CSC_LINK, CSC_KEY_PASSWORD,
//   APPLE_API_KEY_PATH, APPLE_API_KEY, APPLE_API_ISSUER,
//   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_ENDPOINT_URL,
//   SOFIA_R2_BUCKET (optional AWS_REGION)
//
// Flags: --version X.Y.Z  --repo OWNER/REPO  --prefix NAME  --target TRIPLE
//        --env-file PATH  --no-build  --no-github  --no-mirror  --dry-run
//        --ref REF (git ref the GitHub Release tag points at; default: HEAD)

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, mkdtempSync, rmSync, chmodSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..", "..");
const desktopRoot = path.resolve(__dirname, "..");
const distDir = path.join(desktopRoot, "dist-electron");

const options = {
  version: "",
  repo: "RuutChatCSM/sofia-desktop",
  prefix: "sofia-desktop",
  target: "",
  ref: "",
  envFile: path.join(homedir(), ".sofia", "app-release.env"),
  build: true,
  github: true,
  mirror: true,
  dryRun: false,
};

function usage() {
  const header = readFileSync(fileURLToPath(import.meta.url), "utf8")
    .split("\n")
    .slice(1, 16)
    .map((line) => line.replace(/^\/\/ ?/, ""))
    .join("\n");
  process.stderr.write(`${header}\n`);
}

function die(message) {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

const rawArgs = process.argv.slice(2);
for (let i = 0; i < rawArgs.length; i += 1) {
  const arg = rawArgs[i];
  const next = () => rawArgs[i + 1];
  const take = (key) => {
    if (arg.includes("=")) return arg.slice(arg.indexOf("=") + 1);
    const value = next();
    if (value === undefined) die(`${key} requires a value`);
    i += 1;
    return value;
  };
  if (arg === "--version" || arg.startsWith("--version=")) options.version = take("--version");
  else if (arg === "--repo" || arg.startsWith("--repo=")) options.repo = take("--repo");
  else if (arg === "--prefix" || arg.startsWith("--prefix=")) options.prefix = take("--prefix");
  else if (arg === "--target" || arg.startsWith("--target=")) options.target = take("--target");
  else if (arg === "--ref" || arg.startsWith("--ref=")) options.ref = take("--ref");
  else if (arg === "--env-file" || arg.startsWith("--env-file=")) options.envFile = take("--env-file");
  else if (arg === "--no-build") options.build = false;
  else if (arg === "--no-github") options.github = false;
  else if (arg === "--no-mirror") options.mirror = false;
  else if (arg === "--dry-run") options.dryRun = true;
  else if (arg === "-h" || arg === "--help") { usage(); process.exit(0); }
  else die(`unknown argument: ${arg} (try --help)`);
}

function loadEnvFile(file) {
  if (!existsSync(file)) return;
  for (const rawLine of readFileSync(file, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    process.env[key] = rawValue.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
  }
}
loadEnvFile(options.envFile);

const log = (message) => process.stderr.write(`\n==> ${message}\n`);
const run = (command, args, env) => {
  const printable = [command, ...args].join(" ");
  if (options.dryRun) {
    process.stderr.write(`+ ${printable}\n`);
    return;
  }
  const result = spawnSync(command, args, { stdio: "inherit", env: env ? { ...process.env, ...env } : process.env });
  if (result.status !== 0) die(`command failed (${result.status}): ${printable}`);
};
const capture = (command, args) => spawnSync(command, args, { encoding: "utf8" }).stdout?.trim() ?? "";

// `node` may be an x64 build under Rosetta on Apple Silicon, so detect the
// host CPU with uname rather than process.arch.
if (!options.target) {
  options.target = capture("uname", ["-m"]) === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
}

if (process.platform !== "darwin") die("macOS releases must run on macOS");
if (!options.version || !/^\d+\.\d+\.\d+$/.test(options.version)) die("--version X.Y.Z is required");
const tag = `v${options.version}`;

// The release must point at the commit that produced these artifacts. Defaulting to a
// branch name silently tags whatever that branch held at publish time, which is how
// v0.1.1 ended up tagged on `main` while its artifacts came from a feature branch.
const releaseRef = options.ref || capture("git", ["rev-parse", "HEAD"]) || "main";

const arch = options.target.startsWith("aarch64") ? "arm64" : "x64";
const artifacts = [
  `sofia-mac-${arch}-${options.version}.dmg`,
  `sofia-mac-${arch}-${options.version}.dmg.blockmap`,
  `sofia-mac-${arch}-${options.version}.zip`,
  `sofia-mac-${arch}-${options.version}.zip.blockmap`,
].map((name) => path.join(distDir, name));

const p12 = process.env.CSC_LINK;
const p8 = process.env.APPLE_API_KEY_PATH;
if (!p12) die("CSC_LINK is required (path or base64 .p12)");
if (!p8 || !existsSync(p8)) die("APPLE_API_KEY_PATH must point at the .p8 notary key");
if (!process.env.APPLE_API_KEY || !process.env.APPLE_API_ISSUER) die("APPLE_API_KEY and APPLE_API_ISSUER are required");

// ---------------------------------------------------------------------------
// Build (signs + notarizes the .app via electron-after-sign)
// ---------------------------------------------------------------------------
if (options.build) {
  if (!process.env.SOFIA_SOURCE_DIR) die("SOFIA_SOURCE_DIR must point at the Sofia engine checkout");
  log(`Stamping version ${options.version}`);
  run(process.execPath, [path.join(repoRoot, "scripts", "release", "stamp-version.mjs"), "--version", options.version]);
  log(`Building Sofia App ${options.version} (${options.target})`);
  run("pnpm", ["--filter", "@sofia/desktop", "package:electron"], {
    SOFIA_SOURCE_DIR: process.env.SOFIA_SOURCE_DIR,
    TARGET: options.target,
    MACOS_NOTARIZE: "true",
    CSC_LINK: p12,
    CSC_KEY_PASSWORD: process.env.CSC_KEY_PASSWORD ?? "",
    APPLE_API_KEY: process.env.APPLE_API_KEY,
    APPLE_API_ISSUER: process.env.APPLE_API_ISSUER,
    APPLE_API_KEY_PATH: p8,
  });
}

const dmg = artifacts[0];
const zip = artifacts[2];
for (const artifact of [dmg, zip]) {
  if (!options.dryRun && !existsSync(artifact)) die(`missing build artifact: ${artifact}`);
}

// ---------------------------------------------------------------------------
// Sign + notarize + staple the DMG (electron-builder signs the .app only)
// ---------------------------------------------------------------------------
function signAndNotarizeDmg() {
  if (!existsSync(p12)) die(`CSC_LINK must be a .p12 path to sign the DMG: ${p12}`);
  if (options.dryRun) return;
  const keychain = path.join(tmpdir(), `sofia-app-sign-${process.pid}.keychain-db`);
  const keychainPassword = `sofia-app-${process.pid}`;
  try {
    log("Signing, notarizing, and stapling the DMG");
    spawnSync("security", ["delete-keychain", keychain], { stdio: "ignore" });
    run("security", ["create-keychain", "-p", keychainPassword, keychain]);
    run("security", ["set-keychain-settings", "-lut", "3600", keychain]);
    run("security", ["unlock-keychain", "-p", keychainPassword, keychain]);
    run("security", ["import", p12, "-P", process.env.CSC_KEY_PASSWORD ?? "", "-A", "-t", "cert", "-f", "pkcs12", "-k", keychain]);
    run("security", ["import", p12, "-P", process.env.CSC_KEY_PASSWORD ?? "", "-A", "-t", "agg", "-f", "pkcs12", "-k", keychain]);
    run("security", ["set-key-partition-list", "-S", "apple-tool:,apple:,codesign:", "-s", "-k", keychainPassword, keychain]);
    const loginKeychain = path.join(homedir(), "Library", "Keychains", "login.keychain-db");
    run("security", ["list-keychains", "-d", "user", "-s", keychain, loginKeychain]);
    const identity = capture("security", ["find-identity", "-v", "-p", "codesigning", keychain]);
    const match = /"([^"]*Developer ID Application[^"]*)"/.exec(identity);
    if (!match) die("no 'Developer ID Application' identity found in the signing certificate");
    const signer = match[1];
    run("codesign", ["--force", "--timestamp", "--sign", signer, dmg]);
    run("security", ["list-keychains", "-d", "user", "-s", loginKeychain]);
    run("xcrun", ["notarytool", "submit", dmg, "--key", p8, "--key-id", process.env.APPLE_API_KEY, "--issuer", process.env.APPLE_API_ISSUER, "--wait"]);
    run("xcrun", ["stapler", "staple", dmg]);
    run("spctl", ["-a", "-t", "open", "--context", "context:primary-signature", "-v", dmg]);
  } finally {
    if (!options.dryRun) spawnSync("security", ["delete-keychain", keychain], { stdio: "ignore" });
  }
}
if (existsSync(p12)) signAndNotarizeDmg();
else log(`Skipping DMG signing: CSC_LINK is not a local .p12 (${p12})`);

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------
function githubRelease() {
  log(`Publishing GitHub Release ${tag} (${options.repo})`);
  const assets = artifacts.filter((artifact) => options.dryRun || existsSync(artifact));
  const exists = !options.dryRun && spawnSync("gh", ["release", "view", tag, "--repo", options.repo], { stdio: "ignore" }).status === 0;
  if (exists) {
    run("gh", ["release", "upload", tag, "--repo", options.repo, "--clobber", ...assets]);
  } else {
    run("gh", ["release", "create", tag, "--repo", options.repo, "--target", releaseRef,
      "--title", `Sofia App ${options.version}`, "--notes", `Sofia App ${options.version} (macOS, Apple Silicon), signed and notarized.`,
      ...assets]);
  }
}

function mirror() {
  const bucket = process.env.SOFIA_R2_BUCKET;
  const endpoint = process.env.AWS_ENDPOINT_URL;
  if (!bucket || !endpoint) die("SOFIA_R2_BUCKET and AWS_ENDPOINT_URL are required to mirror");
  log(`Mirroring to s3://${bucket}/${options.prefix}/releases/${options.version}/`);
  for (const artifact of artifacts) {
    if (!options.dryRun && !existsSync(artifact)) continue;
    run("aws", ["s3", "cp", artifact, `s3://${bucket}/${options.prefix}/releases/${options.version}/${path.basename(artifact)}`, "--endpoint-url", endpoint, "--only-show-errors"]);
  }
}

if (options.github) githubRelease();
if (options.mirror) mirror();

log(`Done. Sofia App ${options.version} (${tag}).`);
