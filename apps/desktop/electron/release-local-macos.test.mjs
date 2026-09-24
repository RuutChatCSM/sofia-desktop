import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const script = path.resolve(dirname, "..", "scripts", "release-local-macos.mjs");
const repoRoot = path.resolve(dirname, "..", "..", "..");

/**
 * Runs the driver against an isolated HOME so the operator's real
 * `~/.sofia/app-release.env` cannot supply credentials or a source path, and
 * against placeholder signing inputs so the credential gates are satisfied
 * without a real Developer ID certificate.
 */
function runDriver(args) {
  const home = mkdtempSync(path.join(tmpdir(), "sofia-release-driver-"));
  try {
    const key = path.join(home, "notary.p8");
    writeFileSync(key, "placeholder", "utf8");
    return spawnSync(process.execPath, [script, ...args], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        SOFIA_SOURCE_DIR: "",
        CSC_LINK: path.join(home, "signing.p12"),
        CSC_KEY_PASSWORD: "unused",
        APPLE_API_KEY_PATH: key,
        APPLE_API_KEY: "unused",
        APPLE_API_ISSUER: "unused",
      },
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function gitHead() {
  return spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).stdout.trim();
}

describe("local macOS release driver", () => {
  it("refuses to publish a ref other than the checkout being built", () => {
    const result = runDriver(["--version", "9.9.9", "--ref", "HEAD~1", "--dry-run"]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /is not the checkout being built/);
    assert.match(result.stderr, new RegExp(gitHead()));
  });

  it("tags the built commit when no ref is supplied", () => {
    const result = runDriver(["--version", "9.9.9", "--no-build", "--no-mirror", "--dry-run"]);

    assert.equal(result.status, 0);
    assert.match(result.stderr, new RegExp(`--target ${gitHead()} `));
  });

  it("warns that a --no-build publish has no recorded provenance", () => {
    const result = runDriver(["--version", "9.9.9", "--no-build", "--no-mirror", "--dry-run"]);

    assert.equal(result.status, 0);
    assert.match(result.stderr, /no build provenance/);
  });
});
