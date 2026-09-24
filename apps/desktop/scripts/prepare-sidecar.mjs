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
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { dirname, join, resolve } from "path";
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
  process.env.SOFIA_SIDECAR_DIR?.trim() || process.env.SOFIA_SIDECAR_DIR?.trim() || readArg("--outdir");
const sidecarDir = sidecarOverride
  ? resolve(sidecarOverride)
  : join(__dirname, "..", "resources", "sidecars");
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

// sofia-server paths
const sofiaServerDir = resolve(__dirname, "..", "..", "server");

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

// sofia-server is no longer compiled as a sidecar binary — it runs
// in-process inside Electron via a direct import of the server library.
// Server binary copy/sign skipped — runs in-process.

// The desktop ships the Sofia engine built from its source checkout.
const sofiaBaseName = isWindowsTarget ? "sofia.exe" : "sofia";
const sofiaPath = join(sidecarDir, sofiaBaseName);
const sofiaTargetPath = resolvedTargetTriple
  ? join(sidecarDir, `sofia-${resolvedTargetTriple}${isWindowsTarget ? ".exe" : ""}`)
  : null;
const sofiaCandidatePath = sofiaTargetPath ?? sofiaPath;

let existingSofiaVersion = null;
if (sofiaCandidatePath) {
  existingSofiaVersion =
    existsSync(sofiaCandidatePath) && !isStubBinary(sofiaCandidatePath)
      ? readBinaryVersion(sofiaCandidatePath)
      : null;
  // Prefer the sidecar's version stamp (source builds report 0.0.0 via
  // --version, so the stamp carries the checkout rev).
  try {
    const stamp = `${sofiaCandidatePath}.version`;
    if (existsSync(stamp)) {
      const stamped = readFileSync(stamp, "utf8").trim();
      if (stamped) existingSofiaVersion = stamped;
    }
  } catch {
    // ignore
  }
}

// SOFIA_SOURCE_DIR overrides the sibling Sofia engine checkout.
const sofiaSourceDir = (() => {
  const raw = process.env.SOFIA_SOURCE_DIR?.trim() || process.env.CODEX_SOURCE_DIR?.trim();
  if (raw) return resolve(raw);
  // The Sofia engine checkout lives as a sibling repo next to this repo.
  const sibling = resolve(__dirname, "..", "..", "..", "..", "sofia");
  return existsSync(join(sibling, "sofia-rs", "cli", "Cargo.toml")) ? sibling : null;
})();

if (!sofiaSourceDir) {
  throw new Error(
    "Sofia packaging requires its engine source checkout. Set SOFIA_SOURCE_DIR to the Sofia engine repository.",
  );
}

// When building from source, the sidecar's identity is the checkout's git
// HEAD (the release binary reports sofia-cli 0.0.0). This keeps prepare:sidecar
// idempotent and only rebuilds when the checkout advances.
const sofiaSourceRev = (() => {
  const git = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: sofiaSourceDir,
    encoding: "utf8",
  });
  if (git.status !== 0 || !git.stdout)
    throw new Error("Unable to fingerprint Sofia engine source");
  const diff = spawnSync("git", ["diff", "--binary", "HEAD"], {
    cwd: sofiaSourceDir,
    maxBuffer: 32 * 1024 * 1024,
  });
  const untracked = spawnSync(
    "git",
    ["ls-files", "--others", "--exclude-standard", "-z"],
    { cwd: sofiaSourceDir },
  );
  if (diff.status !== 0 || untracked.status !== 0)
    throw new Error("Unable to fingerprint Sofia engine changes");
  const hash = createHash("sha256").update(git.stdout).update(diff.stdout);
  for (const file of untracked.stdout
    .toString()
    .split("\0")
    .filter(Boolean)
    .sort()) {
    hash.update(file).update(readFileSync(join(sofiaSourceDir, file)));
  }
  return hash.digest("hex").slice(0, 20);
})();
const expectedSofiaVersion = sofiaSourceRev;

const shouldBuildSofia =
  (!existsSync(sofiaCandidatePath) ||
    isStubBinary(sofiaCandidatePath) ||
    !existingSofiaVersion ||
    existingSofiaVersion !== expectedSofiaVersion);

if (shouldBuildSofia) {
  mkdirSync(sidecarDir, { recursive: true });

  let extractedSofia = null;
  if (sofiaSourceDir) {
    // Build from source checkout: cargo build -p sofia-cli --release.
    const cargoBin = process.env.CARGO?.trim() || "cargo";
    const build = spawnSync(
      cargoBin,
      ["build", "-p", "sofia-cli", "--release"],
      { cwd: join(sofiaSourceDir, "sofia-rs"), stdio: "inherit" },
    );
    if (build.status !== 0) {
      console.error("Sofia engine source build failed.");
      process.exit(build.status ?? 1);
    }
    const builtBinary = join(
      sofiaSourceDir,
      "sofia-rs",
      "target",
      "release",
      process.platform === "win32" ? "sofia.exe" : "sofia",
    );
    if (existsSync(builtBinary)) extractedSofia = builtBinary;
  }

  if (!extractedSofia) throw new Error("Sofia engine binary was not produced by the source build");

  for (const target of [sofiaTargetPath, sofiaPath].filter(Boolean)) {
    try {
      if (existsSync(target)) unlinkSync(target);
    } catch {
      // ignore
    }
    copyFileSync(extractedSofia, target);
    try {
      chmodSync(target, 0o755);
    } catch {
      // ignore
    }
    changedBinaries.add(target);
    // Version stamp: source builds report sofia-cli 0.0.0, so identity comes
    // from this file (the checkout rev) rather than `--version`.
    try {
      writeFileSync(`${target}.version`, expectedSofiaVersion ?? "");
    } catch {
      // ignore
    }
  }
  console.log(
    `Sofia sidecar updated to ${expectedSofiaVersion} (built from source).`,
  );
} else {
  console.log(
    `Sofia sidecar already present (${existingSofiaVersion ?? "unknown"}).`,
  );
}

// Ad-hoc sign only the sidecars that were actually written this run. Untouched
// binaries keep their existing signature so macOS permission grants (computer
// use) survive across runs.
adHocSignDarwinSidecars([
  ...changedBinaries,
  // sofia-server runs in-process — no binary to sign.
]);

const sofiaServerVersion = (() => {
  try {
    const raw = readFileSync(
      resolve(sofiaServerDir, "package.json"),
      "utf8",
    );
    return String(JSON.parse(raw).version ?? "").trim();
  } catch {
    return null;
  }
})();

const versions = {
  sofia: {
    version: expectedSofiaVersion,
    sha256:
      sofiaCandidatePath && existsSync(sofiaCandidatePath)
        ? sha256File(sofiaCandidatePath)
        : null,
  },
  "sofia-server": {
    version: sofiaServerVersion,
    sha256: "in-process",
  },
};

const missing = Object.entries(versions)
  .filter(
    ([name, info]) =>
      (!info.version || !info.sha256) &&
      ["sofia", "sofia-server"].includes(name),
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
