import { expect } from "vitest";
import { test } from "@sofia/testkit";
import { parseDurableTurnOutcomes } from "../../apps/server/src/codex-turn-outcomes";
const event = (payload: object) => JSON.stringify({ type: "event_msg", payload });

test("rollout outcomes recognize explicit interruption and terminal completion aliases", () => {
  const raw = [event({ type: "task_started", turn_id: "one" }), event({ type: "turn_aborted", reason: "interrupted" }), event({ type: "turn_aborted", turn_id: "two", reason: "replaced" }), event({ type: "task_complete", turn_id: "three", completed_at: 42 }), event({ type: "turn_complete", turn_id: "four", error: { message: "Provider failure" } }), event({ type: "error", turn_id: "ignored", message: "Not terminal" }), "truncated"].join("\n");
  expect(parseDurableTurnOutcomes(raw)).toEqual([{ turnId: "one", outcome: "cancelled" }, { turnId: "two", outcome: "cancelled" }, { turnId: "three", outcome: "completed", completedAt: 42000 }, { turnId: "four", outcome: "failed" }]);
});

test("unsupported abort reasons are not invented and terminal outcomes retain bounded latest records", () => {
  const raw = [event({ type: "turn_aborted", turn_id: "unknown", reason: "review_ended" }), event({ type: "task_complete", turn_id: "one" }), event({ type: "task_complete", turn_id: "two" }), event({ type: "turn_aborted", turn_id: "one", reason: "interrupted" })].join("\n");
  expect(parseDurableTurnOutcomes(raw, 1)).toEqual([{ turnId: "one", outcome: "cancelled" }]);
});
