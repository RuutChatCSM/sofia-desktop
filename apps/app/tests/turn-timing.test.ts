import { describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";

import {
  finishedTurnDurationMs,
  resolveTurnTiming,
  turnWorkLabel,
} from "../src/components/chat/turn-timing";
import { formatToolCallDuration } from "../src/lib/tool-call-duration";

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

  test("user messages never contribute timing", () => {
    const timing = resolveTurnTiming([
      { id: "u", role: "user", metadata: { engine: { created: 1 } }, parts: [] } as UIMessage,
      assistant("a", { created: 3_000, completed: 4_000 }),
    ]);

    expect(timing.startedAt).toBe(3_000);
  });
});
