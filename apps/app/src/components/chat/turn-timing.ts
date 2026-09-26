import type { UIMessage } from "ai";

import { getMessageCompleted, getMessageCreated } from "./utils";

/**
 * Timing for one *logical assistant turn*.
 *
 * A turn is not a message and not the reasoning/tool subset: a continued turn
 * can hold narration, an earlier premature final answer, resumed work, and a
 * trailing answer. Deriving the clock from `stepItems[0]` (or from a single
 * message) lost the start, which is how a turn Sofia had just executed ended up
 * with no duration at all.
 */
export type TurnTiming = {
  startedAt: number | null;
  completedAt: number | null;
};

export type LocalTurnTiming = {
  startedAt?: number | null;
  completedAt?: number | null;
};

/**
 * Priority:
 *   startedAt   — earliest engine `created` across every assistant item, else
 *                 the locally recorded turn start
 *   completedAt — latest engine `completed` across every assistant item, else
 *                 the locally recorded completion
 */
export function resolveTurnTiming(
  messages: readonly UIMessage[],
  local?: LocalTurnTiming,
): TurnTiming {
  let earliestCreated: number | null = null;
  let latestCompleted: number | null = null;

  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const created = getMessageCreated(message);
    if (created !== null && (earliestCreated === null || created < earliestCreated)) {
      earliestCreated = created;
    }
    const completed = getMessageCompleted(message);
    if (completed !== null && (latestCompleted === null || completed > latestCompleted)) {
      latestCompleted = completed;
    }
  }

  return {
    startedAt: earliestCreated ?? local?.startedAt ?? null,
    completedAt: latestCompleted ?? local?.completedAt ?? null,
  };
}

/** Elapsed work time for a *finished* turn, or null when nothing is known. */
export function finishedTurnDurationMs(timing: TurnTiming): number | null {
  const { startedAt, completedAt } = timing;
  if (startedAt === null || completedAt === null) return null;
  return Math.max(0, completedAt - startedAt);
}

/**
 * The work-block header. Live: the semantic operation. Finished: how long the
 * whole turn took. "Worked" alone is the rare legacy fallback for imported
 * history with no timing information at all.
 */
export function turnWorkLabel(input: {
  isLive: boolean;
  activeLabel?: string | null;
  durationMs: number | null;
  formatDuration: (ms: number) => string;
}): string {
  if (input.isLive) return input.activeLabel?.trim() || "Working";
  if (input.durationMs === null) return "Worked";
  return `Worked for ${input.formatDuration(input.durationMs)}`;
}
