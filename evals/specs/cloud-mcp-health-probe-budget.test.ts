import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { expect } from "vitest";
import { test } from "@sofia/testkit";

const repoRoot = resolve(import.meta.dirname, "../..");

test("direct Cloud MCP health checks stay within a scoped handshake budget", ({ evidence }) => {
  const budgetResult = spawnSync("pnpm", [
    "--filter",
    "sofia-server",
    "test",
    "src/cloud-mcp-health.test.ts",
    "--test-name-pattern",
    "direct Cloud probe budget",
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  const budgetOutput = `${budgetResult.stdout}${budgetResult.stderr}`;
  // The reconcile operation benchmark this used to assert was removed with the
  // reconcile optimisation it measured, and the "clean ready persists desired
  // config" witness it named no longer exists. Running it therefore matched zero
  // tests and failed on the summary. The reconcile behaviour itself is covered
  // by apps/server's own suite, so the budget spec now proves only the health
  // probe budget it is named for.

  expect(budgetResult.error, budgetOutput).toBeUndefined();
  expect(budgetResult.status, budgetOutput).toBe(0);
  expect(budgetOutput).toContain("4 pass");
  expect(budgetOutput).toContain("0 fail");
  expect(budgetOutput).toContain("cloud-mcp-probe-operation-benchmark concurrent=6 pre=18 post=3 sequential_explicit=3");

  evidence.recordAssertionEvidence(
    "Only concurrent health checks share a direct handshake",
    "Six checks are released together through deterministic barriers and reduce the 18-operation protocol baseline to 3; the next settled explicit check performs 3 fresh operations.",
    true,
  );
  evidence.recordAssertionEvidence(
    "Upstream failures remain retryable",
    "A tools/list 502 is asserted retryable and the next settled check must perform a complete new initialize, initialized notification, and tools/list handshake.",
    true,
  );
  evidence.recordAssertionEvidence(
    "In-flight reuse is correctness-scoped",
    "Blocked checks require distinct flights across workspaces and Authorization or organization revisions, while provider/model differences share the same direct tools/list flight.",
    true,
  );
  evidence.recordAssertionEvidence(
    "Healthy same-revision delivery state heals",
    "A registering delivery entry with the already-applied revision is required to return to ready after a healthy inspection.",
    true,
  );
});
