import { expect } from "vitest";
import { test } from "@sofia/testkit";

import {
  activityStatusForProcess,
  activityTitleForCommand,
  currentActivity,
  deriveActivities,
  type Activity,
} from "../../apps/app/src/react-app/domains/session/activity.ts";

test("Sofia activity titles are generic operation phrases, not tool names", () => {
  expect(activityTitleForCommand("pnpm test")).toBe("Running tests");
  expect(activityTitleForCommand("vitest run --coverage")).toBe("Running tests");
  expect(activityTitleForCommand("pnpm dev")).toBe("Running the dev server");
  expect(activityTitleForCommand("vite --host")).toBe("Running the dev server");
  expect(activityTitleForCommand("pnpm build")).toBe("Building the project");
  expect(activityTitleForCommand("python reconcile.py")).toBe("Running python reconcile.py");
  // The mechanism name never becomes the activity name.
  expect(activityTitleForCommand("bash -lc 'ls -la'")).not.toMatch(/^bash/i);
});

test("Sofia derives one activity per background process with the process as a resource", () => {
  const activities = deriveActivities("codex-t1", [
    { itemId: "call-bg-1", processId: "1234", command: "pnpm dev", status: "running" },
    { itemId: "call-bg-2", processId: "5678", command: "pnpm test", status: "completed", exitCode: 1 },
  ]);
  expect(activities).toHaveLength(2);
  expect(activities[0]).toMatchObject({
    id: "background_process:call-bg-1",
    sessionId: "codex-t1",
    title: "Running the dev server",
    kind: "work",
    status: "running",
    resources: [{ type: "background_process", processId: "1234" }],
  });
  expect(activities[1].status).toBe("failed");
});

test("Sofia activity status maps process facts and picks the current activity", () => {
  expect(activityStatusForProcess({ itemId: "a", processId: "1", command: "x", status: "running" })).toBe("running");
  expect(activityStatusForProcess({ itemId: "a", processId: "1", command: "x", status: "completed", exitCode: 0 })).toBe("completed");
  expect(activityStatusForProcess({ itemId: "a", processId: "1", command: "x", status: "completed", exitCode: 2 })).toBe("failed");
  expect(activityStatusForProcess({ itemId: "a", processId: "1", command: "x", status: "failed" })).toBe("failed");

  const running: Activity = { id: "r", sessionId: "s", title: "Running tests", kind: "work", status: "running", resources: [] };
  const failed: Activity = { ...running, id: "f", status: "failed" };
  expect(currentActivity([failed])?.id).toBe("f");
  expect(currentActivity([failed, running])?.id).toBe("r");
  expect(currentActivity([])).toBeNull();
});
