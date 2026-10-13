export type DurableTurnOutcome = { turnId: string; outcome: "completed" | "cancelled" | "failed"; startedAt?: number; completedAt?: number };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read only supported terminal rollout events; malformed/truncated lines are ignored. */
export function parseDurableTurnOutcomes(raw: string, limit = 1_000): DurableTurnOutcome[] {
  const outcomes = new Map<string, DurableTurnOutcome>();
  let currentTurn = "";
  const starts = new Map<string, number>();
  for (const line of raw.slice(-8 * 1024 * 1024).split("\n")) {
    let entry: unknown;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!record(entry) || !record(entry.payload)) continue;
    const payload = entry.payload;
    if (entry.type === "turn_context" || (entry.type === "event_msg" && (payload.type === "task_started" || payload.type === "turn_started"))) {
      if (typeof payload.turn_id === "string") currentTurn = payload.turn_id;
      if (entry.type === "event_msg" && currentTurn && typeof entry.timestamp === "string") {
        const start = Date.parse(entry.timestamp);
        if (Number.isFinite(start)) starts.set(currentTurn, start);
      }
      continue;
    }
    if (entry.type !== "event_msg") continue;
    const turnId = typeof payload.turn_id === "string" ? payload.turn_id : currentTurn;
    if (!turnId) continue;
    let outcome: DurableTurnOutcome["outcome"];
    if (payload.type === "turn_aborted" && (payload.reason === "interrupted" || payload.reason === "replaced")) outcome = "cancelled";
    else if (payload.type === "task_complete" || payload.type === "turn_complete") outcome = record(payload.error) ? "failed" : "completed";
    else continue;
    const parsedTime = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
    const completedAt = typeof payload.completed_at === "number" && Number.isFinite(payload.completed_at) ? payload.completed_at * 1_000 : Number.isFinite(parsedTime) ? parsedTime : undefined;
    const startedAt = starts.get(turnId);
    outcomes.delete(turnId);
    outcomes.set(turnId, { turnId, outcome, ...(startedAt === undefined ? {} : { startedAt }), ...(completedAt === undefined ? {} : { completedAt }) });
    if (outcomes.size > limit) outcomes.delete(outcomes.keys().next().value ?? "");
  }
  return [...outcomes.values()];
}
