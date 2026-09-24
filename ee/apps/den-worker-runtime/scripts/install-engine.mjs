#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const runtimeRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repoRoot = resolve(runtimeRoot, "..", "..", "..");
const outputDir = resolve(runtimeRoot, "bin");
const outputName = process.platform === "win32" ? "engine.exe" : "engine";
const outputPath = join(outputDir, outputName);
const versionStampPath = join(outputDir, "engine.version");

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(" ")}`);
  }
  return result;
}

function resolveWorkspaceEngineVersion() {
  const versionPath = resolve(repoRoot, "constants.json");
  if (!existsSync(versionPath)) {
    throw new Error(`Missing pinned constants file at ${versionPath}`);
  }
  const parsed = JSON.parse(readFileSync(versionPath, "utf8"));
  const version = String(parsed.engineVersion ?? "").trim().replace(/^v/, "");
  if (!version) {
    throw new Error(`Pinned Sofia version is missing from ${versionPath}`);
  }
  return version;
}

function resolveAssetName() {
  const target = `${process.platform}-${process.arch}`;
  const assets = {
    "darwin-arm64": "engine-darwin-arm64.zip",
    "darwin-x64": "engine-darwin-x64-baseline.zip",
    "linux-arm64": "engine-linux-arm64.tar.gz",
    "linux-x64": "engine-linux-x64-baseline.tar.gz",
    "win32-arm64": "engine-windows-arm64.zip",
    "win32-x64": "engine-windows-x64-baseline.zip",
  };

  const asset = assets[target];
  if (!asset) {
    throw new Error(`Unsupported platform for engine bundle: ${target}`);
  }
  return asset;
}

async function downloadWithRetries(url, destination) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      writeFileSync(destination, buffer);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, attempt * 1000));
      }
    }
  }

  throw new Error(`Failed to download ${url}: ${String(lastError)}`);
}

function extractArchive(archivePath, outputDirectory) {
  if (archivePath.endsWith(".tar.gz")) {
    run("tar", ["-xzf", archivePath, "-C", outputDirectory], runtimeRoot);
    return;
  }

  if (archivePath.endsWith(".zip")) {
    if (process.platform === "win32") {
      run(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          `Expand-Archive -Path '${archivePath.replace(/'/g, "''")}' -DestinationPath '${outputDirectory.replace(/'/g, "''")}' -Force`,
        ],
        runtimeRoot,
      );
      return;
    }

    run("unzip", ["-q", archivePath, "-d", outputDirectory], runtimeRoot);
    return;
  }

  throw new Error(`Unsupported archive format: ${basename(archivePath)}`);
}

function findBinary(searchRoot) {
  const stack = [searchRoot];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;

    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const entryPath = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
        continue;
      }
      if (entry.isFile() && entry.name === outputName) {
        return entryPath;
      }
    }
  }

  throw new Error(`Unable to find ${outputName} inside extracted archive`);
}

const version = resolveWorkspaceEngineVersion();
const versionLabel = version;

if (
  existsSync(outputPath) &&
  existsSync(versionStampPath) &&
  readFileSync(versionStampPath, "utf8").trim() === versionLabel
) {
  console.log(`[den-worker-runtime] engine ${versionLabel} already bundled at ${outputPath}`);
  process.exit(0);
}

const assetName = resolveAssetName();
const downloadUrl = process.env.SOFIA_SOFIA_ENGINE_DOWNLOAD_URL?.trim()
  || (version
    ? `https://github.com/RuutChatCSM/sofia/releases/download/v${version}/${assetName}`
    : null);
if (!downloadUrl) {
  throw new Error("Pinned Sofia version is required to bundle the worker runtime");
}
const tempDir = mkdtempSync(join(tmpdir(), "den-worker-engine-"));
const archivePath = join(tempDir, assetName);
const extractDir = join(tempDir, "extract");

mkdirSync(extractDir, { recursive: true });
mkdirSync(outputDir, { recursive: true });

try {
  console.log(`[den-worker-runtime] downloading engine ${versionLabel} from ${downloadUrl}`);
  await downloadWithRetries(downloadUrl, archivePath);
  extractArchive(archivePath, extractDir);
  const extractedBinary = findBinary(extractDir);
  copyFileSync(extractedBinary, outputPath);
  if (process.platform !== "win32") {
    chmodSync(outputPath, 0o755);
  }
  writeFileSync(versionStampPath, `${versionLabel}\n`, "utf8");
  console.log(`[den-worker-runtime] bundled engine ${versionLabel} at ${outputPath}`);
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
