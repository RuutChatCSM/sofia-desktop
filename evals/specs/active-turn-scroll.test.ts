import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { test } from "@sofia/testkit";

const messageListPath = fileURLToPath(
  new URL("../../apps/app/src/components/chat/message-list.tsx", import.meta.url),
);
const sessionSurfacePath = fileURLToPath(
  new URL("../../apps/app/src/react-app/domains/session/surface/session-surface.tsx", import.meta.url),
);

/**
 * The active-session cutoff came from a second scroll view inside the
 * transcript: a height-capped step list that streaming pinned to its own
 * bottom, hiding the earlier part of the live turn. There is exactly one
 * vertical scroll owner, and it is the session transcript.
 */
test("a live turn has one vertical scroll owner", () => {
  const source = readFileSync(messageListPath, "utf8");
  const markerIndex = source.indexOf('data-live-steps=""');
  const liveSteps = markerIndex >= 0 ? source.slice(markerIndex - 200, markerIndex + 200) : "";

  expect(markerIndex).toBeGreaterThan(-1);
  expect(liveSteps).not.toContain("overflow-y-auto");
  expect(liveSteps).not.toContain("max-h-[280px]");
  // The step-list auto-pin and "scrolling live thinking" gesture bookkeeping are
  // gone, not merely disabled.
  expect(source).not.toContain("shouldFollowLiveStepGrowth");
  expect(source).not.toContain("pinnedAfterWheel");
  expect(source).not.toContain("node.scrollTop = node.scrollHeight");

  // The scrolling region itself is the transcript, exactly once.
  const surface = readFileSync(sessionSurfacePath, "utf8");
  expect(surface.match(/overflow-y-auto/g) ?? []).toHaveLength(1);

  // And the inner-scroller helper cannot be reintroduced silently.
  expect(
    existsSync(fileURLToPath(new URL("../../apps/app/src/components/chat/live-step-scroll.ts", import.meta.url))),
  ).toBe(false);
});

/**
 * One work unit per assistant turn: a turn that arrived as six reasoning items
 * must read as one collapsible header, not six stacked "Thought" rows. Engine
 * item boundaries are transport detail, not transcript structure.
 */
test("an assistant turn renders as a single work block", () => {
  const source = readFileSync(messageListPath, "utf8");

  expect(source).toContain("function TurnWorkBlock(");
  expect(source).toContain("function useLiveElapsed(");
  // The per-item fold label and the separate completed-run component are gone.
  expect(source).not.toContain("CompletedStepRun");
  expect(source).not.toContain("COLLAPSED_STEP_RUN_MIN_ROWS");
  // Reasoning is owned by the block, so prose messages never re-render it.
  expect(source).toContain("renderItems(proseItems, stepItems.length, true)");

  // One clock for the whole logical turn: never derived from the reasoning/tool
  // subset, or a prose-only / continued turn loses its duration.
  expect(source).toContain("resolveTurnTiming(");
  expect(source).toContain("finishedTurnDurationMs(");
  expect(source).toContain("turnWorkLabel(");
  expect(source).not.toContain("stepsStartedAt");
  expect(source).not.toContain("getMessageCompleted(lastItem.message)");
});

/**
 * A process that exited without emitting an exit item would leave the client's
 * Activity snapshot saying "running" forever. The surface reconciles against the
 * server's live list when the turn ends, not only when the session changes.
 */
test("the activity surface reconciles stale resources when the turn ends", () => {
  const status = readFileSync(
    fileURLToPath(new URL(`${surfaceDir}/activity-status.tsx`, import.meta.url)),
    "utf8",
  );

  expect(status).toContain("refreshBackgroundProcesses(sessionId)");
  expect(status).toContain("[sessionId, turnActive]");
});

const surfaceDir = "../../apps/app/src/react-app/domains/session/surface";

/**
 * "At the bottom" is geometry; "following the conversation" is intent. Content
 * growth, a composer resize and a late-loading image all move the geometry
 * without the user leaving the tail, so they must never detach follow mode —
 * only a real gesture (or an explicit navigation) may.
 */
test("follow mode is intent-driven, not distance-driven", () => {
  const controller = readFileSync(fileURLToPath(new URL(`${surfaceDir}/scroll-controller.ts`, import.meta.url)), "utf8");
  const overlay = readFileSync(fileURLToPath(new URL(`${surfaceDir}/scroll-overlay.tsx`, import.meta.url)), "utf8");
  const surface = readFileSync(sessionSurfacePath, "utf8");

  // A tail sentinel decides whether the affordance is worth showing.
  expect(controller).toContain("IntersectionObserver");
  expect(controller).toContain("tailSentinelRef");
  expect(surface).toContain("data-tail-sentinel");
  // Our own scrolls are marked, so they cannot be read as user intent.
  expect(controller).toContain("programmaticScrollUntilRef");
  // The old pure-geometry classifier is gone.
  expect(controller).not.toContain("function isAtBottom(");
  expect(overlay).not.toContain("showJumpToLatest = !isAtBottom");
  // Real gestures are recorded as intent.
  expect(surface).toContain('type: "wheel", direction:');
  expect(surface).toContain('type: "touch", direction:');
  expect(surface).toContain("sessionScroll.markNavigatedAway()");
});
