import { describe, expect, test } from "bun:test";

import {
  activityStatusLabel,
  activityTitleForStatus,
  currentActivity,
  deriveActivities,
  liveActivityLabel,
  runningActivities,
  shouldSurfaceActivity,
  type Activity,
} from "../src/react-app/domains/session/activity";

const activity = (overrides: Partial<Activity>): Activity => ({
  id: "a",
  sessionId: "s",
  title: "Running tests",
  kind: "work",
  status: "running",
  resources: [],
  ...overrides,
});

describe("activity presentation model", () => {
  test("the state lives inside the activity, in the user's words", () => {
    expect(activityStatusLabel("running")).toBe("Running");
    expect(activityStatusLabel("waiting")).toBe("Needs you");
    expect(activityStatusLabel("failed")).toBe("Needs you");
    expect(activityStatusLabel("completed")).toBe("Finished");
  });

  test("an orchestrator-supplied title beats the command", () => {
    const [named] = deriveActivities("s", [
      {
        itemId: "call-bg-1",
        processId: "1234",
        command: "python reconcile.py",
        title: "Preparing the reconciliation",
        status: "running",
      },
    ]);
    expect(named.title).toBe("Preparing the reconciliation");

    const [unnamed] = deriveActivities("s", [
      { itemId: "call-bg-2", processId: "5678", command: "pnpm test", status: "running" },
    ]);
    expect(unnamed.title).toBe("Running tests");
  });

  test("the activity is the one live-progress line, the tool is the fallback", () => {
    const running = activity({ status: "running", title: "Running the app tests" });

    // One presenter: the Activity wins over an in-flight tool label...
    expect(liveActivityLabel([running], "Reading foo.ts")).toBe("Running the app tests");
    // ...the tool label covers non-background work...
    expect(liveActivityLabel([], "Reading foo.ts")).toBe("Reading foo.ts");
    // ...and null means the caller shows its generic working text.
    expect(liveActivityLabel([], null)).toBeNull();
    expect(liveActivityLabel([activity({ status: "completed" })], null)).toBeNull();
  });

  test("a resource that stopped never keeps a Running title", () => {
    expect(activityTitleForStatus(activity({ status: "running", title: "Running tests" }))).toBe("Running tests");
    expect(activityTitleForStatus(activity({ status: "failed", title: "Running tests" }))).toBe("Tests failed");
    expect(activityTitleForStatus(activity({ status: "failed", title: "Running the app tests" }))).toBe("The app tests failed");
    expect(activityTitleForStatus(activity({ status: "failed", title: "Building the project" }))).toBe("Building the project failed");
  });

  test("history never raises the persistent surface", () => {
    // A failed or completed process must not leave a chip behind that claims to
    // be running ("Needs you" + "Nothing is running right now." was impossible).
    expect(shouldSurfaceActivity([activity({ status: "failed" })], false)).toBe(false);
    expect(shouldSurfaceActivity([activity({ status: "completed" })], false)).toBe(false);
    expect(shouldSurfaceActivity([activity({ status: "running" })], false)).toBe(true);
    // ...even when a live one is alongside it, only the live state counts.
    expect(
      shouldSurfaceActivity(
        [activity({ id: "live", status: "running" }), activity({ id: "dead", status: "failed" })],
        false,
      ),
    ).toBe(true);
    expect(runningActivities([activity({ status: "failed" })])).toEqual([]);
  });

  test("the composer surface is only for work that outlives the turn", () => {
    const running = activity({ status: "running" });
    const completed = activity({ id: "done", status: "completed" });

    expect(shouldSurfaceActivity([running], false)).toBe(true);
    expect(shouldSurfaceActivity([running], true)).toBe(false);
    expect(shouldSurfaceActivity([completed], false)).toBe(false);
    expect(shouldSurfaceActivity([], false)).toBe(false);

    // A failure still needs the user once the turn is over.
    const failed = activity({ id: "f", status: "failed" });
    expect(currentActivity([failed])?.id).toBe("f");
    expect(runningActivities([running, failed])).toEqual([running]);
  });
});
