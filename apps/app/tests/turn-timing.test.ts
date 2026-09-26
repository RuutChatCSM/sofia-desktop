import { describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";

import {
  finishedTurnDurationMs,
  resolveTurnTiming,
  turnWorkLabel,
} from "../src/components/chat/turn-timing";
import { formatToolCallDuration } from "../src/lib/tool-call-duration";
import { getMessageCompleted, getMessageCreated } from "../src/components/chat/utils";
import {
  useCodexSessionStore,
  type CodexTrackedItem,
} from "../src/react-app/domains/session/codex-session-store";

function assistant(id: string, engine: Record<string, unknown>): UIMessage {
  return {
    id,
    role: "assistant",
    metadata: { engine },
    parts: [{ type: "text", text: "…", state: "done" }],
  } as UIMessage;
}

const label = (durationMs: number | null, isLive = false, activeLabel: string | null = null) =>
  turnWorkLabel({ isLive, activeLabel, durationMs, formatDuration: formatToolCallDuration });

describe("one clock per logical assistant turn", () => {
  test("a continued turn reports the whole span, not just the last stretch", () => {
    // work 40s → premature "final" → evaluator continues → 55s more.
    const turn = [
      assistant("a1", { created: 0, completed: 40_000, phase: "final_answer" }),
      assistant("a2", { created: 41_000, completed: 95_000, phase: "final_answer" }),
    ];

    const timing = resolveTurnTiming(turn);

    expect(timing).toEqual({ startedAt: 0, completedAt: 95_000 });
    expect(finishedTurnDurationMs(timing)).toBe(95_000);
    // 1m 35s — not 55s, and not a bare "Worked".
    expect(label(finishedTurnDurationMs(timing))).toBe("Worked for 1m 35s");
  });

  test("the start is the earliest item, so narration and reasoning are included", () => {
    // A turn whose work subset is empty (all narration/answer) still has a clock:
    // the old renderer derived it from stepItems[0] and lost it.
    const timing = resolveTurnTiming([
      assistant("narrate", { created: 5_000, completed: 6_000, phase: "commentary" }),
      assistant("answer", { created: 7_000, completed: 20_000, phase: "final_answer" }),
    ]);

    expect(timing.startedAt).toBe(5_000);
    expect(finishedTurnDurationMs(timing)).toBe(15_000);
    expect(label(finishedTurnDurationMs(timing))).toBe("Worked for 15s");
  });

  test("the locally recorded clock covers turns whose items have no metadata", () => {
    const timing = resolveTurnTiming(
      [{ id: "a", role: "assistant", parts: [{ type: "text", text: "done", state: "done" }] } as UIMessage],
      { startedAt: 1_000, completedAt: 61_000 },
    );

    expect(timing).toEqual({ startedAt: 1_000, completedAt: 61_000 });
    expect(finishedTurnDurationMs(timing)).toBe(60_000);
  });

  test("engine metadata wins over the local clock when both are present", () => {
    const timing = resolveTurnTiming(
      [assistant("a1", { created: 2_000, completed: 6_000 })],
      { startedAt: 1_000, completedAt: 9_000 },
    );

    expect(timing).toEqual({ startedAt: 2_000, completedAt: 6_000 });
  });

  test("imported history with no timing at all is the only 'Worked' fallback", () => {
    const timing = resolveTurnTiming([
      { id: "old", role: "assistant", parts: [{ type: "text", text: "hi", state: "done" }] } as UIMessage,
    ]);

    expect(timing).toEqual({ startedAt: null, completedAt: null });
    expect(finishedTurnDurationMs(timing)).toBeNull();
    expect(label(null)).toBe("Worked");
  });

  test("a live turn is named by the operation, not by a duration", () => {
    expect(label(null, true, "Running the app tests")).toBe("Running the app tests");
    expect(label(null, true, "   ")).toBe("Working");
    expect(label(null, true, null)).toBe("Working");
  });

  test("codex items are timed from the locally observed clock", () => {
    // The codex wire carries no created/completed, so the adapter forwards the
    // clock the store stamped when each item first appeared.
    const local = (createdAt: number, completedAt: number): UIMessage =>
      ({
        id: `i-${createdAt}`,
        role: "assistant",
        metadata: { engine: { turnId: "t1" }, local: { createdAt, completedAt } },
        parts: [{ type: "text", text: "…", state: "done" }],
      }) as UIMessage;

    const turn = [local(0, 40_000), local(41_000, 95_000)];

    expect(getMessageCreated(turn[0])).toBe(0);
    expect(getMessageCompleted(turn[1])).toBe(95_000);
    expect(finishedTurnDurationMs(resolveTurnTiming(turn))).toBe(95_000);
    expect(label(finishedTurnDurationMs(resolveTurnTiming(turn)))).toBe("Worked for 1m 35s");
  });

  test("an engine timestamp still wins over the locally observed one", () => {
    const message = {
      id: "a",
      role: "assistant",
      metadata: { engine: { created: 10, completed: 20 }, local: { createdAt: 1_000, completedAt: 9_000 } },
      parts: [],
    } as UIMessage;

    expect(getMessageCreated(message)).toBe(10);
    expect(getMessageCompleted(message)).toBe(20);
  });

  test("user messages never contribute timing", () => {
    const timing = resolveTurnTiming([
      { id: "u", role: "user", metadata: { engine: { created: 1 } }, parts: [] } as UIMessage,
      assistant("a", { created: 3_000, completed: 4_000 }),
    ]);

    expect(timing.startedAt).toBe(3_000);
  });
});

describe("the item clock is stamped once and never reset", () => {
  function tracked(id: string): CodexTrackedItem {
    return { id, type: "reasoning", turnId: "t1", item: {}, text: "", thinking: "", output: "", status: "pending" };
  }

  test("a later item starting does not move an earlier item's start", () => {
    // Regression: the codex stream calls startTurn on *every* item.started, and
    // the renderer had to fall back to that session clock — so a 95s turn whose
    // last item started 2s before the end read "Worked for 2s".
    const store = useCodexSessionStore.getState();
    store.clear();
    store.replaceSessions([
      { id: "codex-t1", threadId: "t1", title: "x", workspaceId: "ws", created: "2026-01-01", turnId: null, status: "idle" },
    ]);

    store.upsertItem("codex-t1", tracked("i1"));
    const firstStart = useCodexSessionStore.getState().sessions["codex-t1"]?.items[0]?.createdAt;
    expect(typeof firstStart).toBe("number");

    store.startTurn("codex-t1");
    store.upsertItem("codex-t1", tracked("i2"));
    store.startTurn("codex-t1");
    store.completeItem("codex-t1", "i2", { status: "completed" });

    const items = useCodexSessionStore.getState().sessions["codex-t1"]?.items ?? [];
    expect(items.find((item) => item.id === "i1")?.createdAt).toBe(firstStart);
    expect(typeof items.find((item) => item.id === "i2")?.completedAt).toBe("number");

    // Re-upserting an item (engine echoes it again) keeps its original start.
    store.upsertItem("codex-t1", tracked("i1"));
    expect(useCodexSessionStore.getState().sessions["codex-t1"]?.items.find((item) => item.id === "i1")?.createdAt).toBe(firstStart);

    useCodexSessionStore.getState().clear();
  });

  test("the whole turn reads from its first and last item, not its last stretch", () => {
    const messages = [
      { id: "i1", role: "assistant", metadata: { local: { createdAt: 0, completedAt: 40_000 } }, parts: [] },
      { id: "i2", role: "assistant", metadata: { local: { createdAt: 93_000, completedAt: 95_000 } }, parts: [] },
    ] as UIMessage[];

    // A 95s turn, not the 2s of its final item.
    expect(finishedTurnDurationMs(resolveTurnTiming(messages))).toBe(95_000);
  });
});
