import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect } from "vitest";
import { test } from "@sofia/testkit";

const repoRoot = resolve(import.meta.dirname, "../..");

test("OAuth token clients receive isolated attempt and failure budgets", ({ evidence }) => {
  const reportDir = mkdtempSync(join(tmpdir(), "sofia-oauth-token-rate-limit-"));
  const reportPath = join(reportDir, "bun-junit.xml");
  try {
    const result = spawnSync("pnpm", [
      "--filter",
      "@sofia-ee/den-api",
      "exec",
      "bun",
      "test",
      "test/oauth-token-rate-limit.test.ts",
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
    expect(summary).toContain('tests="5"');
    expect(summary).toContain('failures="0"');
    expect(summary).toContain('skipped="0"');
    expect(junit).not.toContain("<failure");
    expect(junit).not.toContain("<skipped");

    evidence.recordAssertionEvidence(
      "OAuth clients behind one public IP have independent attempt budgets",
      "The focused runtime witness exhausts client A's 60-request bucket, observes its 429, and then observes a successful exchange for client B on the same IP.",
      true,
    );
    evidence.recordAssertionEvidence(
      "Repeated authentication failures trigger a stricter budget",
      "The focused runtime witness observes only 15 failed handler exchanges before the next request is rejected before authentication with an OAuth-compatible 429.",
      true,
    );
    evidence.recordAssertionEvidence(
      "Pre-handler normalization rejections consume the failure budget",
      "The focused runtime witness records 15 pre-handler 400 rejections without running the token handler and requires the 16th request to be blocked with a 429 while the failure bucket shows exactly 15 entries.",
      true,
    );
    evidence.recordAssertionEvidence(
      "Successful token exchanges do not consume the failure budget",
      "The focused runtime witness observes no failure bucket after 30 successful exchanges and requires 15 actual failures before pre-handler rejection.",
      true,
    );
    evidence.recordAssertionEvidence(
      "Durable OAuth rate-limit keys contain no raw identities",
      "The focused runtime witness inspects every generated key, requires hashed IP/client buckets, and rejects raw client IDs and IP addresses while also proving anonymous and rotating-client ceilings.",
      true,
    );
  } finally {
    rmSync(reportDir, { force: true, recursive: true });
  }
});
