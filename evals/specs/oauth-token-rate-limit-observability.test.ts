import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect } from "vitest";
import { test } from "@sofia/testkit";

const repoRoot = resolve(import.meta.dirname, "../..");

test("OAuth token rate-limit diagnostics remain safe", ({ evidence }) => {
  const reportDir = mkdtempSync(join(tmpdir(), "sofia-oauth-rate-limit-"));
  const reportPath = join(reportDir, "bun-junit.xml");
  try {
    const result = spawnSync("pnpm", [
      "--filter",
      "@sofia-ee/den-api",
      "exec",
      "bun",
      "test",
      "test/oauth-token-rate-limit-observability.test.ts",
      "--reporter=junit",
      "--reporter-outfile",
      reportPath,
    ], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: 60_000,
    });
    const output = `${result.stdout}${result.stderr}`;
    expect(result.error, output).toBeUndefined();
    expect(result.status, output).toBe(0);

    const junit = readFileSync(reportPath, "utf8");
    const summary = junit.match(/<testsuite\b[^>]*>/)?.[0] ?? "";
    expect(summary).toContain('tests="4"');
    expect(summary).toContain('failures="0"');
    expect(summary).toContain('skipped="0"');
    expect(junit).not.toContain("<failure");
    expect(junit).not.toContain("<skipped");

    evidence.recordAssertionEvidence(
      "Rate-limit diagnostics do not expose OAuth credentials",
      "The focused runtime witness rejects raw client IDs, client secrets, refresh tokens, authorization codes, and raw user-agent strings while retaining a client fingerprint and category.",
      true,
    );
  } finally {
    rmSync(reportDir, { force: true, recursive: true });
  }
});
