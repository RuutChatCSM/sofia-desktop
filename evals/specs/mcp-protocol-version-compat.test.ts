import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect } from "vitest";
import { test } from "@sofia/testkit";

const repoRoot = resolve(import.meta.dirname, "../..");

test("MCP endpoints tolerate newer or duplicated protocol-version headers", ({ evidence }) => {
  const reportDir = mkdtempSync(join(tmpdir(), "sofia-mcp-protocol-version-"));
  const reportPath = join(reportDir, "bun-junit.xml");
  try {
    const result = spawnSync("pnpm", [
      "--filter",
      "@sofia-ee/den-api",
      "exec",
      "bun",
      "test",
      "test/mcp-protocol-version.test.ts",
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
      "A newer negotiated protocol version no longer fails stateless MCP requests",
      "The focused runtime witness sends notifications/initialized with an unknown mcp-protocol-version through the real StreamableHTTPTransport, observes the JSON-RPC 404 control without normalization, and observes 202 with normalization.",
      true,
    );
    evidence.recordAssertionEvidence(
      "Duplicated negotiated headers collapse instead of failing",
      "The focused runtime witness appends an identical mcp-protocol-version copy, observes the comma-joined value, and requires normalization to restore the single negotiated version.",
      true,
    );
    evidence.recordAssertionEvidence(
      "Supported and missing headers pass through untouched",
      "The focused runtime witness requires normalization to leave a supported version and an absent header exactly as received.",
      true,
    );
  } finally {
    rmSync(reportDir, { force: true, recursive: true });
  }
});
