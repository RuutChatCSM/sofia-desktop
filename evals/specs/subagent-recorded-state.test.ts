import { expect } from "vitest";
import { test } from "@sofia/testkit";
import { recordedSubagentState } from "../../apps/server/src/codex-subagent-outcome";
const event = (type: string, extra: object = {}) => JSON.stringify({type: "event_msg", timestamp: "2026-10-11T02:14:10.909Z", payload: {type, turn_id: "worker-turn", ...extra}});

test("worker terminal state uses explicit completed, failed and interrupted records", () => {
  expect(recordedSubagentState(event("task_complete"))).toEqual({agentStatus: "completed", agentUpdatedAt: "2026-10-11T02:14:10.909Z"});
  expect(recordedSubagentState(event("task_complete", {error: {message: "failure"}})).agentStatus).toBe("failed");
  expect(recordedSubagentState(event("turn_aborted", {reason: "interrupted"})).agentStatus).toBe("interrupted");
});

test("later worker start invalidates old completion; idle and arbitrary prose never imply success", () => {
  expect(recordedSubagentState(event("task_complete") + "\n" + event("task_started", {turn_id: "new-turn"}))).toMatchObject({agentStatus: "working"});
  expect(recordedSubagentState(event("task_started"))).toMatchObject({agentStatus: "working"});
  expect(recordedSubagentState('{"type":"response_item","payload":{"text":"Done"}}\n{truncated')).toEqual({agentStatus: "unknown"});
  expect(recordedSubagentState(event("turn_aborted", {reason: "unknown"}))).toEqual({agentStatus: "unknown"});
});
