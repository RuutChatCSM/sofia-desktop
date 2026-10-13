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
 *   Full recorded turn boundaries override individual item clocks.
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
  let recordedStarted: number | null = null;
  let recordedCompleted: number | null = null;

  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const metadata:unknown=message.metadata;
    const engine=metadata && typeof metadata==="object" && "engine" in metadata ? metadata.engine : null;
    if(engine && typeof engine==="object"){
      if("turnStartedAt" in engine && typeof engine.turnStartedAt==="number" && Number.isFinite(engine.turnStartedAt))recordedStarted=recordedStarted===null?engine.turnStartedAt:Math.min(recordedStarted,engine.turnStartedAt);
      if("turnCompletedAt" in engine && typeof engine.turnCompletedAt==="number" && Number.isFinite(engine.turnCompletedAt))recordedCompleted=recordedCompleted===null?engine.turnCompletedAt:Math.max(recordedCompleted,engine.turnCompletedAt);
    }
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
    startedAt: recordedStarted ?? earliestCreated ?? local?.startedAt ?? null,
    completedAt: recordedCompleted ?? latestCompleted ?? local?.completedAt ?? null,
  };
}

/** Elapsed work time for a *finished* turn, or null when nothing is known. */
export function finishedTurnDurationMs(timing: TurnTiming): number | null {
  const { startedAt, completedAt } = timing;
  if (startedAt === null || completedAt === null) return null;
  return Math.max(0, completedAt - startedAt);
}

/** Only an explicit wire outcome can identify an interrupted turn. */
export function turnWorkOutcome(messages: readonly UIMessage[]): "stopped" | "failed" | undefined {
  for (const message of [...messages].reverse()) {
    const metadata: unknown = message.metadata;
    if (!metadata || typeof metadata !== "object" || !("engine" in metadata)) continue;
    const engine: unknown = metadata.engine;
    if (!engine || typeof engine !== "object" || !("turnOutcome" in engine)) continue;
    if (engine.turnOutcome === "cancelled") return "stopped";
    if (engine.turnOutcome === "failed") return "failed";
    if (engine.turnOutcome === "completed") return undefined;
  }
  return undefined;
}

/** Shipped mGc/_Gc: whole seconds, narrow units, omit zero units. */
export function formatTurnWorkDuration(ms: number, locale = "en"): string {
  const seconds = Math.floor(Math.max(ms, 0) / 1000);
  const unit = (value: number, name: "day" | "hour" | "minute" | "second") => {
    const formatter = new Intl.NumberFormat(locale, { style: "unit", unit: name, unitDisplay: "narrow" });
    return locale.toLowerCase().split("-")[0] === "hu"
      ? formatter.formatToParts(value).filter(part => part.type !== "literal").map(part => part.value).join("")
      : formatter.format(value);
  };
  if (seconds < 60) return unit(seconds, "second");
  const values: Array<[number, "day" | "hour" | "minute" | "second"]> = [
    [Math.floor(seconds / 86400), "day"],
    [Math.floor(seconds / 3600) % 24, "hour"],
    [Math.floor(seconds / 60) % 60, "minute"],
    [seconds % 60, "second"],
  ];
  return values.filter(([value]) => value > 0).map(([value, name]) => unit(value, name)).join(" ");
}

/**
 * The work-block header. Live: elapsed work time. Finished: how long the
 * whole turn took. Saved activity without timing makes no completion claim.
 * Recovered from shipped app-primary LW: unknown is "Activity", and stopped
 * is distinct from worked. Callers must supply stopped/paused explicitly.
 */
export function turnWorkLabel(input: {
  isLive: boolean;
  activeLabel?: string | null;
  elapsedMs?: number | null;
  durationMs: number | null;
  status?: "stopped" | "paused" | "failed";
  formatDuration: (ms: number) => string;
}): string {
  if (input.status === "paused") return "Paused";
  if (input.status === "failed") return "Activity";
  if (input.status === "stopped") {
    return input.durationMs === null ? "You stopped" : `You stopped after ${input.formatDuration(input.durationMs)}`;
  }
  if (input.isLive) return input.elapsedMs !== undefined && input.elapsedMs !== null && input.elapsedMs >= 1000
    ? `Working for ${input.formatDuration(input.elapsedMs)}` : "Working";
  if (input.durationMs === null) return "Activity";
  return `Worked for ${input.formatDuration(input.durationMs)}`;
}
