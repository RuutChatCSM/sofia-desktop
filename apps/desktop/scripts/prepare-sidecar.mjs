import { spawnSync } from "child_process";
import { createHash } from "crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { dirname, join, resolve } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const readArg = (name) => {
  const raw = process.argv.slice(2);
  const direct = raw.find((arg) => arg.startsWith(`${name}=`));
  if (direct) return direct.split("=")[1];
  const index = raw.indexOf(name);
  if (index >= 0 && raw[index + 1]) return raw[index + 1];
  return null;
};

const sidecarOverride =
  process.env.OPENWORK_SIDECAR_DIR?.trim() || readArg("--outdir");
const sidecarDir = sidecarOverride
  ? resolve(sidecarOverride)
  : join(__dirname, "..", "resources", "sidecars");
const constantsPath = resolve(__dirname, "..", "..", "..", "constants.json");

const normalizeVersion = (value) => {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  if (raw.toLowerCase() === "latest") return null;
  return raw.startsWith("v") ? raw.slice(1) : raw;
};

// Target triple for native platform binaries
const resolvedTargetTriple = (() => {
  const envTarget =
    process.env.TAURI_ENV_TARGET_TRIPLE ??
    process.env.CARGO_CFG_TARGET_TRIPLE ??
    process.env.TARGET;
  if (envTarget) return envTarget;
  if (process.platform === "darwin") {
    return process.arch === "arm64"
      ? "aarch64-apple-darwin"
      : "x86_64-apple-darwin";
  }
  if (process.platform === "linux") {
    return process.arch === "arm64"
      ? "aarch64-unknown-linux-gnu"
      : "x86_64-unknown-linux-gnu";
  }
  if (process.platform === "win32") {
    return process.arch === "arm64"
      ? "aarch64-pc-windows-msvc"
      : "x86_64-pc-windows-msvc";
  }
  return null;
})();
const isWindowsTarget =
  process.platform === "win32" ||
  resolvedTargetTriple?.includes("windows") === true;

// Binaries (re)written during this run. Ad-hoc macOS signatures are only applied
// to these so an unchanged binary keeps its existing signature — and therefore
// its existing Accessibility/Screen Recording permission grant. Re-signing an
// unchanged sidecar on every run changes its cdhash, so macOS treats it as a new
// app and re-prompts for computer-use permissions each launch.
const changedBinaries = new Set();

// openwork-server paths
const openworkServerDir = resolve(__dirname, "..", "..", "server");

const readHeader = (filePath, length = 256) => {
  const fd = openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const bytesRead = readSync(fd, buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    closeSync(fd);
  }
};

const isStubBinary = (filePath) => {
  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) return true;
    if (stat.size < 1024) return true;
    const header = readHeader(filePath);
    if (header.startsWith("#!")) return true;
    if (
      header.includes("Sidecar missing") ||
      header.includes("Bun is required")
    )
      return true;
  } catch {
    return true;
  }
  return false;
};

const readDirectory = (dir) => {
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries.flatMap((entry) => {
    const next = join(dir, entry.name);
    if (entry.isDirectory()) {
      return readDirectory(next);
    }
    if (entry.isFile()) {
      return [next];
    }
    return [];
  });
};

const readBinaryVersion = (filePath) => {
  try {
    const result = spawnSync(filePath, ["--version"], { encoding: "utf8" });
    if (result.status === 0 && result.stdout) return result.stdout.trim();
  } catch {
    // ignore
  }
  return null;
};

const sha256File = (filePath) => {
  const hash = createHash("sha256");
  hash.update(readFileSync(filePath));
  return hash.digest("hex");
};

const adHocSignDarwin = (filePath) => {
  if (process.platform !== "darwin" || !filePath || !existsSync(filePath))
    return;
  const remove = spawnSync("codesign", ["--remove-signature", filePath], {
    encoding: "utf8",
  });
  if (remove.error && remove.error.code === "ENOENT") {
    throw new Error("codesign is required to prepare runnable macOS sidecars");
  }

  const sign = spawnSync("codesign", ["--force", "--sign", "-", filePath], {
    encoding: "utf8",
  });
  if (sign.error) {
    if (sign.error.code === "ENOENT") {
      throw new Error(
        "codesign is required to prepare runnable macOS sidecars",
      );
    }
    throw sign.error;
  }
  if (sign.status !== 0) {
    const stderr = sign.stderr?.trim();
    throw new Error(
      `Failed to codesign ${filePath}${stderr ? `: ${stderr}` : ""}`,
    );
  }
};

const adHocSignDarwinSidecars = (paths) => {
  if (process.platform !== "darwin") return;
  for (const filePath of [...new Set(paths.filter(Boolean))]) {
    adHocSignDarwin(filePath);
  }
};

// openwork-server is no longer compiled as a sidecar binary — it runs
// in-process inside Electron via a direct import of the server library.
// Server binary copy/sign skipped — runs in-process.

// OpenCode sidecar removed. The desktop ships only the Codex/Sofia engine.

// ── Codex sidecar ────────────────────────────────────────────────────────────
const codexVersion = (() => {
  try {
    const raw = readFileSync(constantsPath, "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed.codexVersion === "string"
      ? parsed.codexVersion.trim() || null
      : null;
  } catch {
    return null;
  }
})();
const normalizedCodexVersion = normalizeVersion(codexVersion);
const codexBaseName = isWindowsTarget ? "codex.exe" : "codex";
const codexPath = join(sidecarDir, codexBaseName);
const codexTargetName = resolvedTargetTriple
  ? `codex-${resolvedTargetTriple}${isWindowsTarget ? ".exe" : ""}`
  : null;
const codexTargetPath = codexTargetName
  ? join(sidecarDir, codexTargetName)
  : null;
const codexCandidatePath = codexTargetPath ?? codexPath;

const findCodexBinary = (dir) => {
  const candidates = readDirectory(dir);
  return (
    candidates.find(
      (file) =>
        file.endsWith(`/${codexBaseName}`) ||
        file.endsWith(`\\${codexBaseName}`),
    ) ??
    candidates.find(
      (file) => file.endsWith("/codex") || file.endsWith("\\codex"),
    ) ??
    candidates.find(
      (file) => file.endsWith("/codex.exe") || file.endsWith("\\codex.exe"),
    ) ??
    // Codex release tarballs contain a single flat binary named
    // `codex-<target-triple>` (no `codex` wrapper file).
    candidates.find((file) => /codex[^/\\]*$/.test(file)) ??
    null
  );
};

let existingCodexVersion = null;
if (codexCandidatePath) {
  existingCodexVersion =
    existsSync(codexCandidatePath) && !isStubBinary(codexCandidatePath)
      ? readBinaryVersion(codexCandidatePath)
      : null;
  // Prefer the sidecar's version stamp (source builds report 0.0.0 via
  // --version, so the stamp carries the checkout rev).
  try {
    const stamp = `${codexCandidatePath}.version`;
    if (existsSync(stamp)) {
      const stamped = readFileSync(stamp, "utf8").trim();
      if (stamped) existingCodexVersion = stamped;
    }
  } catch {
    // ignore
  }
}

const codexAssetByTarget = {
  "aarch64-apple-darwin": "codex-aarch64-apple-darwin.tar.gz",
  "x86_64-apple-darwin": "codex-x86_64-apple-darwin.tar.gz",
  "x86_64-unknown-linux-gnu": "codex-x86_64-unknown-linux-gnu.tar.gz",
  "aarch64-unknown-linux-gnu": "codex-aarch64-unknown-linux-gnu.tar.gz",
  "x86_64-pc-windows-msvc": "codex-x86_64-pc-windows-msvc.tar.gz",
  "aarch64-pc-windows-msvc": "codex-aarch64-pc-windows-msvc.tar.gz",
};

const codexAsset =
  process.env.CODEX_ASSET?.trim() ??
  (resolvedTargetTriple ? codexAssetByTarget[resolvedTargetTriple] : null);
const codexUrl =
  codexAsset && normalizedCodexVersion
    ? `https://github.com/openai/codex/releases/download/${normalizedCodexVersion}/${codexAsset}`
    : null;

// The bundled codex engine is built from the mona-chen/codex source checkout
// (never the system-installed binary). prepare-sidecar builds the CLI from this
// checkout; set CODEX_SOURCE_DIR to override the resolved path.
const codexSourceDir = (() => {
  const raw = process.env.CODEX_SOURCE_DIR?.trim();
  if (raw) return resolve(raw);
  // The Sofia engine checkout lives as a sibling repo next to this repo.
  for (const name of ["sofia", "codex"]) {
    const sibling = resolve(__dirname, "..", "..", "..", "..", name);
    if (existsSync(join(sibling, "sofia-rs", "cli", "Cargo.toml")))
      return sibling;
  }
  return null;
})();

if (!codexSourceDir) {
  throw new Error(
    "Sofia packaging requires its engine source checkout. Set CODEX_SOURCE_DIR; upstream Codex is not a compatible substitute.",
  );
}

// When building from source, the sidecar's identity is the checkout's git
// HEAD (the release binary reports codex-cli 0.0.0). This keeps prepare:sidecar
// idempotent and only rebuilds when the checkout advances.
const codexSourceRev = (() => {
  if (!codexSourceDir) return null;
  const git = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: codexSourceDir,
    encoding: "utf8",
  });
  if (git.status !== 0 || !git.stdout)
    throw new Error("Unable to fingerprint Sofia engine source");
  const diff = spawnSync("git", ["diff", "--binary", "HEAD"], {
    cwd: codexSourceDir,
    maxBuffer: 32 * 1024 * 1024,
  });
  const untracked = spawnSync(
    "git",
    ["ls-files", "--others", "--exclude-standard", "-z"],
    { cwd: codexSourceDir },
  );
  if (diff.status !== 0 || untracked.status !== 0)
    throw new Error("Unable to fingerprint Sofia engine changes");
  const hash = createHash("sha256").update(git.stdout).update(diff.stdout);
  for (const file of untracked.stdout
    .toString()
    .split("\0")
    .filter(Boolean)
    .sort()) {
    hash.update(file).update(readFileSync(join(codexSourceDir, file)));
  }
  return hash.digest("hex").slice(0, 20);
})();
const codexBuildSource = codexSourceDir ? "source" : "release";
// A source build's stamp is the checkout rev; release builds use the pinned tag.
const expectedCodexVersion = codexSourceRev
  ? codexSourceRev
  : normalizedCodexVersion;

const shouldDownloadCodex =
  Boolean(expectedCodexVersion) &&
  (!codexCandidatePath ||
    !existsSync(codexCandidatePath) ||
    isStubBinary(codexCandidatePath) ||
    !existingCodexVersion ||
    existingCodexVersion !== expectedCodexVersion);

if (shouldDownloadCodex) {
  mkdirSync(sidecarDir, { recursive: true });

  let extractedCodex = null;
  if (codexSourceDir) {
    // Build from source checkout: cargo build -p codex-cli --release.
    const cargoBin = process.env.CARGO?.trim() || "cargo";
    const build = spawnSync(
      cargoBin,
      ["build", "-p", "sofia-cli", "--release"],
      { cwd: join(codexSourceDir, "sofia-rs"), stdio: "inherit" },
    );
    if (build.status !== 0) {
      console.error("Sofia engine source build failed.");
      process.exit(build.status ?? 1);
    }
    const builtBinary = join(
      codexSourceDir,
      "sofia-rs",
      "target",
      "release",
      process.platform === "win32" ? "sofia.exe" : "sofia",
    );
    if (existsSync(builtBinary)) extractedCodex = builtBinary;
  }

  if (!extractedCodex && (!codexAsset || !codexUrl)) {
    console.error(
      `No Codex asset configured for target ${resolvedTargetTriple ?? "unknown"} and no source checkout to build from. Set CODEX_SOURCE_DIR or CODEX_ASSET.`,
    );
    process.exit(1);
  }

  if (!extractedCodex) {
    const stamp = Date.now();
    const archivePath = join(tmpdir(), `codex-${stamp}-${codexAsset}`);
    const extractDir = join(tmpdir(), `codex-${stamp}`);
    mkdirSync(extractDir, { recursive: true });

    const downloadResult = spawnSync(
      "curl",
      ["-fsSL", "-o", archivePath, codexUrl],
      {
        stdio: "inherit",
      },
    );
    if (downloadResult.status !== 0) {
      process.exit(downloadResult.status ?? 1);
    }
    const tarResult = spawnSync(
      "tar",
      ["-xzf", archivePath, "-C", extractDir],
      {
        stdio: "inherit",
      },
    );
    if (tarResult.status !== 0) {
      process.exit(tarResult.status ?? 1);
    }

    extractedCodex = findCodexBinary(extractDir);
    if (!extractedCodex) {
      console.error("Codex binary not found after extraction.");
      process.exit(1);
    }
  }

  for (const target of [codexTargetPath, codexPath].filter(Boolean)) {
    try {
      if (existsSync(target)) unlinkSync(target);
    } catch {
      // ignore
    }
    copyFileSync(extractedCodex, target);
    try {
      chmodSync(target, 0o755);
    } catch {
      // ignore
    }
    changedBinaries.add(target);
    // Version stamp: source builds report codex-cli 0.0.0, so identity comes
    // from this file (the checkout rev) rather than `--version`.
    try {
      writeFileSync(`${target}.version`, expectedCodexVersion ?? "");
    } catch {
      // ignore
    }
  }
  console.log(
    `Codex sidecar updated to ${expectedCodexVersion ?? normalizedCodexVersion} (${codexBuildSource === "source" ? "built from source" : "downloaded"}).`,
  );
} else if (normalizedCodexVersion) {
  console.log(
    `Codex sidecar already present (${existingCodexVersion ?? "unknown"}).`,
  );
}

// Ad-hoc sign only the sidecars that were actually written this run. Untouched
// binaries keep their existing signature so macOS permission grants (computer
// use) survive across runs.
adHocSignDarwinSidecars([
  ...changedBinaries,
  // openwork-server runs in-process — no binary to sign.
]);

const openworkServerVersion = (() => {
  try {
    const raw = readFileSync(
      resolve(openworkServerDir, "package.json"),
      "utf8",
    );
    return String(JSON.parse(raw).version ?? "").trim();
  } catch {
    return null;
  }
})();

const versions = {
  codex: {
    version: expectedCodexVersion ?? normalizedCodexVersion,
    sha256:
      codexCandidatePath && existsSync(codexCandidatePath)
        ? sha256File(codexCandidatePath)
        : null,
  },
  "openwork-server": {
    version: openworkServerVersion,
    sha256: "in-process",
  },
};

const missing = Object.entries(versions)
  .filter(
    ([name, info]) =>
      (!info.version || !info.sha256) &&
      ["codex", "openwork-server"].includes(name),
  )
  .map(([name]) => name);

if (missing.length) {
  console.error(
    `Sidecar version metadata incomplete for: ${missing.join(", ")}`,
  );
  process.exit(1);
}

const versionsPath = join(sidecarDir, "versions.json");
try {
  mkdirSync(sidecarDir, { recursive: true });
  const content = JSON.stringify(versions, null, 2) + "\n";
  writeFileSync(versionsPath, content, "utf8");
  if (resolvedTargetTriple) {
    const targetSuffix = isWindowsTarget ? ".exe" : "";
    const targetVersionsPath = join(
      sidecarDir,
      `versions.json-${resolvedTargetTriple}${targetSuffix}`,
    );
    writeFileSync(targetVersionsPath, content, "utf8");
  }
} catch (error) {
  console.error(`Failed to write versions.json: ${error}`);
  process.exit(1);
}
