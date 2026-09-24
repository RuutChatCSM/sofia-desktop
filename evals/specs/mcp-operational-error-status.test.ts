import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect } from "vitest";
import { test } from "@sofia/testkit";

const repoRoot = resolve(import.meta.dirname, "../..");

test("operational routes preserve HTTPException responses without exposing unexpected errors", ({ evidence }) => {
  const reportDir = mkdtempSync(join(tmpdir(), "sofia-mcp-operational-errors-"));
  const reportPath = join(reportDir, "bun-junit.xml");
  try {
    const result = spawnSync("pnpm", [
      "--filter",
      "@sofia-ee/den-api",
      "exec",
      "bun",
      "test",
      "test/operational-errors.test.ts",
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
    expect(summary).toContain('tests="12"');
    expect(summary).toContain('failures="0"');
    expect(summary).toContain('skipped="0"');
    expect(junit).not.toContain("<failure");
    expect(junit).not.toContain("<skipped");

    evidence.recordAssertionEvidence(
      "MCP HTTPException responses retain client status and JSON-RPC fields",
      "The focused runtime test throws an HTTPException(404) through the sanitized Hono error flow and requires its JSON-RPC response fields plus a nested referenceId.",
      true,
    );
    evidence.recordAssertionEvidence(
      "Unexpected MCP errors remain sanitized",
      "The focused runtime test throws a plain Error and requires a sanitized 500 body with no provider-controlled exception text.",
      true,
    );
    evidence.recordAssertionEvidence(
      "OAuth HTTPException responses retain status and normalized OAuth metadata",
      "The focused runtime test requires a thrown OAuth HTTPException to keep status, OAuth fields, and WWW-Authenticate while gaining no-store headers and reference_id.",
      true,
    );
  } finally {
    rmSync(reportDir, { force: true, recursive: true });
  }
});
