import type { UIMessage } from "ai";
import { expect } from "vitest";
import { test } from "@sofia/testkit";
import {
  finishedTurnDurationMs,
  resolveTurnTiming,
} from "../../apps/app/src/components/chat/turn-timing";

function assistant(id: string, metadata: UIMessage["metadata"]): UIMessage {
  return {
    id,
    role: "assistant",
    metadata,
    parts: [{ type: "text", text: "…", state: "done" }],
  };
}

test("live and restored turns measure the same engine-recorded duration", () => {
  const engineStartedAt = 10_000;
  const engineCompletedAt = 15_000;

  // Live: the renderer received the engine turn boundary from the session.
  // The local receive clock (0/15_000) is only a fallback.
  const live = [
    assistant("live", {
      engine: { turnId: "turn-1", turnStartedAt: engineStartedAt, turnCompletedAt: engineCompletedAt },
      local: { createdAt: 0, completedAt: engineCompletedAt },
    }),
  ];

  // Restored: the server stamped the rollout's task_started/task_complete
  // boundary and the individual item clocks.
  const restored = [
    assistant("restored-1", {
      engine: {
        turnId: "turn-1",
        turnStartedAt: engineStartedAt,
        turnCompletedAt: engineCompletedAt,
        created: 10_400,
        completed: 14_600,
      },
      local: { createdAt: 10_400, completedAt: 14_600 },
    }),
    assistant("restored-2", {
      engine: { turnId: "turn-1", created: 11_200, completed: 15_000 },
      local: { createdAt: 11_200, completedAt: 15_000 },
    }),
  ];

  expect(finishedTurnDurationMs(resolveTurnTiming(live))).toBe(5_000);
  expect(finishedTurnDurationMs(resolveTurnTiming(restored))).toBe(5_000);
  expect(resolveTurnTiming(live)).toEqual(resolveTurnTiming(restored));
});

test("a live turn without an engine boundary still falls back to item clocks", () => {
  const live = [
    assistant("live-1", { local: { createdAt: 2_000, completedAt: 4_000 } }),
    assistant("live-2", { local: { createdAt: 4_500, completedAt: 7_000 } }),
  ];

  expect(finishedTurnDurationMs(resolveTurnTiming(live))).toBe(5_000);
});

test("live items take the engine boundary observed from the running session", async () => {
  const { useCodexSessionStore } = await import("../../apps/app/src/react-app/domains/session/codex-session-store");
  const { syncCodexTranscriptToCache } = await import("../../apps/app/src/react-app/domains/session/sync/codex-transcript-adapter");
  const { getReactQueryClient } = await import("../../apps/app/src/react-app/infra/query-client");
  const { transcriptKey } = await import("../../apps/app/src/react-app/domains/session/sync/session-sync");

  const store = useCodexSessionStore.getState();
  store.clear();
  const id = "codex-timing-live";
  const workspace = "timing-live-workspace";
  const base = {
    id,
    threadId: "timing-live",
    title: "Timing",
    workspaceId: workspace,
    created: "2026-11-25",
  };
  store.upsertSession({ ...base, turnId: null, status: "idle" });

  // The user pressed send now; the engine did not start the turn until later.
  store.startTurn(id);
  const engineStartedAt = Date.now() - 5_000;
  store.upsertSession({ ...base, turnId: "turn-1", status: "running", updated: new Date(engineStartedAt).toISOString() });
  store.upsertItem(id, {
    id: "work",
    turnId: "turn-1",
    type: "agentMessage",
    item: { id: "work", type: "agentMessage", text: "Working", phase: "commentary" },
    text: "Working",
    thinking: "",
    output: "",
    status: "pending",
  });

  syncCodexTranscriptToCache(workspace, id);
  const messages = getReactQueryClient().getQueryData<UIMessage[]>(transcriptKey(workspace, id)) ?? [];
  expect(resolveTurnTiming(messages).startedAt).toBe(engineStartedAt);

  const engineCompletedAt = engineStartedAt + 3_000;
  store.upsertSession({ ...base, turnId: null, status: "idle", updated: new Date(engineCompletedAt).toISOString() });
  store.completeTurn(id, "completed");
  syncCodexTranscriptToCache(workspace, id);
  const completed = getReactQueryClient().getQueryData<UIMessage[]>(transcriptKey(workspace, id)) ?? [];
  expect(resolveTurnTiming(completed)).toEqual({ startedAt: engineStartedAt, completedAt: engineCompletedAt });
  expect(finishedTurnDurationMs(resolveTurnTiming(completed))).toBe(3_000);
  store.clear();
});
