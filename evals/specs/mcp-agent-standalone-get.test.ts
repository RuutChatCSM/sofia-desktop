import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { expect } from "vitest";
import { test } from "@sofia/testkit";

const repoRoot = resolve(import.meta.dirname, "../..");

test("MCP agent rejects standalone GET without triggering the Bun SDK retry loop", ({ evidence }) => {
  const reportDir = mkdtempSync(join(tmpdir(), "sofia-mcp-agent-standalone-get-"));
  try {
    const build = spawnSync("pnpm", [
      "--filter",
      "@sofia-ee/den-api",
      "run",
      "build:mcp-apps",
    ], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: 120_000,
    });
    const buildOutput = `${build.stdout}${build.stderr}`;
    expect(build.error, buildOutput).toBeUndefined();
    expect(build.status, buildOutput).toBe(0);

    const suites = [
      { file: "test/agent-mcp-routes.test.ts", tests: 3 },
      { file: "test/mcp-membership-revocation.test.ts", tests: 20 },
      { file: "test/mcp-agent-standalone-get.test.ts", tests: 2 },
    ];
    for (const [index, suite] of suites.entries()) {
      const reportPath = join(reportDir, `bun-junit-${String(index)}.xml`);
      const result = spawnSync("pnpm", [
        "--filter",
        "@sofia-ee/den-api",
        "exec",
        "bun",
        "test",
        "--conditions",
        "development",
        "--timeout",
        "15000",
        suite.file,
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
      const summary = junit.match(/<testsuites\b[^>]*>/)?.[0] ?? "";
      expect(summary).toContain(`tests="${String(suite.tests)}"`);
      expect(summary).toContain('failures="0"');
      expect(summary).toContain('skipped="0"');
      expect(junit).not.toContain("<failure");
      expect(junit).not.toContain("<skipped");
    }

    evidence.recordAssertionEvidence(
      "Anonymous standalone GET still returns the OAuth discovery challenge",
      "The focused route witness sends GET /mcp/agent without a bearer and requires the RFC 9728 HTTP 401 challenge instead of bypassing authentication.",
      true,
    );
    evidence.recordAssertionEvidence(
      "Authenticated standalone GET is rejected as an unsupported method",
      "The focused route witness verifies the bearer first, then requires HTTP 405 with Allow: POST and an empty body.",
      true,
    );
    evidence.recordAssertionEvidence(
      "Bun and MCP SDK 1.29.0 do not reopen the rejected standalone listener",
      "The network witness starts the real StreamableHTTPClientTransport, sends notifications/initialized, observes exactly one GET, waits 2.25 seconds past two default retry intervals, and still observes exactly one GET.",
      true,
    );
  } finally {
    rmSync(reportDir, { force: true, recursive: true });
  }
});
