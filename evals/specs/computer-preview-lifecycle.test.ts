import { expect } from "vitest";
import { test } from "@sofia/testkit";
import { createComputerPreviewLease } from "../../apps/desktop/electron/computer-preview-lease.mjs";
import { computerPreviewSize, placeComputerPreview } from "../../apps/app/src/react-app/domains/session/panel/computer-preview-layout";

const scope = { sessionId: "session-a", runStartedAt: 100_000, leaseId: "lease-a" };
const frame = { helperPid: 10, pid: 20, windowNumber: 30, presentationId: "native-a", revision: 1,
  capturedAt: 101, imageWidth: 800, imageHeight: 600, app: "Fixture", windowTitle: "Fixture window", imageUrl: "fixture" };
function deferred<T>() {
  let finish: (value: T) => void = () => { throw new Error("Deferred not initialized"); };
  const promise = new Promise<T>((resolve) => { finish = resolve; });
  return { promise, finish };
}

test("preview leases reject wrong owners, old runs, publishers, target changes and reversed frames", async ({ evidence }) => {
  let preview: typeof frame | null = frame;
  const opens: number[] = [];
  const grants: unknown[] = [];
  const broker = createComputerPreviewLease({ now: () => 102_000, readPreview: async () => preview,
    captureSource: async () => ({ id: "window:30:0" }), openPreview: async (target: typeof frame) => { opens.push(target.pid); return true; },
    sourceChanged: (source: unknown) => grants.push(source) });
  expect(broker.begin(7, scope)).toBe(true);
  expect(await broker.read(8, scope)).toBeNull();
  expect(await broker.read(7, { ...scope, sessionId: "session-b" })).toBeNull();
  preview = { ...frame, capturedAt: 99 };
  expect(await broker.read(7, scope)).toBeNull();
  preview = frame;
  expect(await broker.read(7, scope)).toEqual(frame);
  expect(await broker.capture(7, scope, frame)).toBe("window:30:0");
  expect(await broker.open(7, scope, frame)).toBe(true);
  preview = { ...frame, revision: 2, windowNumber: 31 };
  expect(await broker.open(7, scope, frame)).toBe(false);
  expect(await broker.capture(7, scope, frame)).toBeNull();
  expect(opens).toEqual([20]);
  expect(grants.at(-1)).toBeNull();
  preview = frame;
  expect(await broker.read(7, scope)).toBeNull();
  preview = { ...frame, helperPid: 99, revision: 3 };
  expect(await broker.read(7, scope)).toBeNull();
  preview = { ...frame, presentationId: "native-b", revision: 3 };
  expect(await broker.read(7, scope)).toBeNull();
  preview = { ...frame, capturedAt: 110 };
  expect(await broker.read(7, scope)).toBeNull();
  expect(broker.release(8, scope)).toBe(false);
  expect(broker.release(7, scope)).toBe(true);
  expect(await broker.read(7, scope)).toBeNull();
  evidence.recordAssertionEvidence("Preview identity and ordering boundary", "Wrong renderer/session, pre-run and future captures, reversed revisions and different native publishers are rejected. Open and capture reject an obsolete target. Releasing the lease revokes reads and capture access.", true);
});

test("obsolete capture and frame requests cannot revive a released or superseded preview", async ({ evidence }) => {
  const enumeration = deferred<{ id: string }>();
  let preview: typeof frame | null = frame;
  const grants: unknown[] = [];
  const broker = createComputerPreviewLease({ now: () => 102_000, readPreview: async () => preview,
    captureSource: () => enumeration.promise, openPreview: async () => true, sourceChanged: (source: unknown) => grants.push(source) });
  broker.begin(7, scope);
  const pending = broker.capture(7, scope, frame);
  await Promise.resolve(); await Promise.resolve();
  preview = null;
  expect(await broker.read(7, scope)).toBeNull();
  enumeration.finish({ id: "window:30:0" });
  expect(await pending).toBeNull();
  expect(grants.every((grant) => grant === null)).toBe(true);

  const incoming = deferred<typeof frame>();
  const second = createComputerPreviewLease({ now: () => 102_000, readPreview: () => incoming.promise,
    captureSource: async () => null, openPreview: async () => true, sourceChanged() {} });
  second.begin(7, scope);
  const oldRead = second.read(7, scope);
  const newScope = { ...scope, sessionId: "session-b", leaseId: "lease-b" };
  second.begin(7, newScope);
  expect(second.release(7, scope)).toBe(false);
  incoming.finish(frame);
  expect(await oldRead).toBeNull();
  expect(await second.read(7, newScope)).toEqual(frame);
  second.releaseOwner(7);
  expect(await second.read(7, newScope)).toBeNull();
  evidence.recordAssertionEvidence("Async preview cleanup", "A delayed source enumeration cannot grant capture after its frame disappears. Delayed reads and old cleanup cannot replace or release a newer session lease. Renderer destruction revokes the current lease.", true);
});

test("preview size preserves aspect and placement avoids the composer with drag bounds", ({ evidence }) => {
  expect(computerPreviewSize(800, 600)).toEqual({ width: 200, height: 150 });
  expect(computerPreviewSize(100, 400)).toEqual({ width: 50, height: 200 });
  expect(computerPreviewSize(10, 5, 500)).toEqual({ width: 400, height: 200 });
  expect(computerPreviewSize(0, 0, NaN)).toEqual({ width: 200, height: 200 });
  expect(computerPreviewSize(100, 50, -1)).toEqual({ width: 1, height: 1 });
  const size = { width: 200, height: 150 };
  const host = { width: 900, height: 600 };
  const obstacle = { x: 600, y: 0, width: 300, height: 240 };
  const position = placeComputerPreview(size, host, [obstacle], null);
  expect(position.x + size.width <= obstacle.x - 12 || position.y >= obstacle.y + obstacle.height + 12).toBe(true);
  expect(placeComputerPreview(size, host, [], null)).toEqual({ x: 676, y: 24 });
  expect(placeComputerPreview(size, host, [], { x: 9_000, y: -1_000 })).toEqual({ x: 676, y: 24 });
  expect(placeComputerPreview(size, { width: 200, height: 150 }, [], { x: 100, y: 100 })).toEqual({ x: 0, y: 0 });
  evidence.recordAssertionEvidence("Preview sizing and placement", "Landscape and portrait retain aspect at maximum 200; requested limits clamp to 1–400. Automatic placement clears expanded obstacles and dragging stays inside the host.", true);
});

test("activity refreshes keep one preview run identity and completion clears it", async ({ evidence }) => {
  const { useSessionActivityStore } = await import("../../apps/app/src/react-app/domains/session/status/session-activity-store");
  const activity = useSessionActivityStore.getState();
  activity.setRunStatus("preview-spec", "task", "running");
  const startedAt = useSessionActivityStore.getState().recordsByWorkspaceId["preview-spec"].task.runStartedAt;
  expect(startedAt).toBeGreaterThan(0);
  activity.setRunStatus("preview-spec", "task", "retry");
  activity.seedSessionRun("preview-spec", "task", "running", true, { snapshotStartedAt: Date.now() });
  expect(useSessionActivityStore.getState().recordsByWorkspaceId["preview-spec"].task.runStartedAt).toBe(startedAt);
  activity.setRunStatus("preview-spec", "task", "idle");
  expect(useSessionActivityStore.getState().recordsByWorkspaceId["preview-spec"].task.runStartedAt).toBeNull();
  activity.setRunStatus("preview-spec", "task", "running");
  activity.setError("preview-spec", "task", "cancelled");
  expect(useSessionActivityStore.getState().recordsByWorkspaceId["preview-spec"].task.runStartedAt).toBeNull();
  activity.removeSession("preview-spec", "task");
  evidence.recordAssertionEvidence("Stable preview run", "Repeated running/retry/snapshot status updates retain the same start identity. Idle and failure clear it, so media follows lifecycle rather than status refresh timestamps.", true);
});

 test("preview completion requires explicit success and a new run clears the badge", async ({ evidence }) => {
  const { useSessionActivityStore } = await import("../../apps/app/src/react-app/domains/session/status/session-activity-store");
  const store = useSessionActivityStore.getState();
  store.setRunStatus("preview-outcome", "session", "busy");
  const first = useSessionActivityStore.getState().recordsByWorkspaceId["preview-outcome"].session.previewRunStartedAt;
  store.setRunStatus("preview-outcome", "session", "idle");
  expect(useSessionActivityStore.getState().recordsByWorkspaceId["preview-outcome"].session.previewCompletedAt).toBeNull();
  store.completePreview("preview-outcome", "session", "completed");
  expect(useSessionActivityStore.getState().recordsByWorkspaceId["preview-outcome"].session.previewCompletedAt).toBeTypeOf("number");
  expect(useSessionActivityStore.getState().recordsByWorkspaceId["preview-outcome"].session.previewRunStartedAt).toBe(first);
  store.setRunStatus("preview-outcome", "session", "busy");
  expect(useSessionActivityStore.getState().recordsByWorkspaceId["preview-outcome"].session.previewCompletedAt).toBeNull();
  for (const outcome of ["cancelled", "failed", undefined]) {
    store.completePreview("preview-outcome", "session", outcome);
    expect(useSessionActivityStore.getState().recordsByWorkspaceId["preview-outcome"].session.previewCompletedAt).toBeNull();
    expect(useSessionActivityStore.getState().recordsByWorkspaceId["preview-outcome"].session.previewRunStartedAt).toBeNull();
  }
  evidence.recordAssertionEvidence("Outcome-specific completion", "Idle alone never shows success; explicit completed preserves run identity and timestamp; new runs reset completion; cancellation, failure and missing outcomes remove it.", true);
});
