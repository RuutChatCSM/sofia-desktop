import { parseDurableTurnOutcomes } from "./codex-turn-outcomes.js";

export type RecordedAgentState = {
  agentStatus: "working" | "completed" | "failed" | "interrupted" | "unknown";
  agentUpdatedAt?: string;
};

/** Recover the latest explicit worker lifecycle event, never infer state from idle. */
export function recordedSubagentState(raw: string): RecordedAgentState {
  let latest: { turnId: string; terminal: boolean; timestamp?: string } | undefined;
  for (const line of raw.slice(-8 * 1024 * 1024).split("\n")) {
    try {
      const entry = JSON.parse(line);
      const payload = entry?.payload;
      if (entry?.type !== "event_msg" || !payload || typeof payload.turn_id !== "string") continue;
      if (!["task_started", "turn_started", "task_complete", "turn_complete", "turn_aborted"].includes(payload.type)) continue;
      latest = { turnId: payload.turn_id, terminal: !["task_started", "turn_started"].includes(payload.type), ...(typeof entry.timestamp === "string" && Number.isFinite(Date.parse(entry.timestamp)) ? {timestamp: entry.timestamp} : {}) };
    } catch { /* Truncated records are not state evidence. */ }
  }
  if (!latest) return {agentStatus: "unknown"};
  if (!latest.terminal) return {agentStatus: "working", ...(latest.timestamp ? {agentUpdatedAt:latest.timestamp} : {})};
  const outcome = parseDurableTurnOutcomes(raw).find(outcome => outcome.turnId === latest.turnId);
  if (!outcome) return {agentStatus: "unknown"};
  return {
    agentStatus: outcome.outcome === "cancelled" ? "interrupted" : outcome.outcome,
    ...(latest.timestamp ? {agentUpdatedAt: latest.timestamp} : {}),
  };
}
