import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { test } from "@sofia/testkit";

const workflowPath = fileURLToPath(
  new URL("../../.github/workflows/daytona-e2e-regression-suite.yml", import.meta.url),
);

test("Daytona E2E regression concurrency is isolated by pull request", async ({ evidence }) => {
  const workflow = await readFile(workflowPath, "utf8");

  expect(workflow).toContain(
    "group: daytona-e2e-regression-suite-${{ github.event.workflow_run.pull_requests[0].number || github.run_id }}",
  );
  expect(workflow).toContain("cancel-in-progress: true");
  expect(workflow).not.toContain("group: daytona-e2e-regression-suite\n");

  evidence.recordAssertionEvidence(
    "A waiting Daytona regression run cannot block unrelated pull requests",
    "The workflow uses a PR-scoped concurrency key, falls back to a unique manual-run key, and supersedes only an older run with the same key.",
    true,
  );
});
