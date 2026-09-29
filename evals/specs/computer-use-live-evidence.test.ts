import { readFile } from "node:fs/promises";
import { expect } from "vitest";
import { test } from "@sofia/testkit";

const rollout = process.env.SOFIA_COMPUTER_USE_LIVE_ROLLOUT;

test.skipIf(!rollout)("live Computer Use changes only the isolated fixture through AX and verifies a fresh snapshot", async ({ evidence }) => {
  if (!rollout) throw new Error("needs: SOFIA_COMPUTER_USE_LIVE_ROLLOUT from a completed native fixture test");
  const events = (await readFile(rollout, "utf8")).trim().split("\n").map((line) => JSON.parse(line).payload);
  const calls = events.filter((event) => event?.type === "function_call");
  expect(calls.map((call) => call.name)).toEqual(["list_apps", "snapshot", "set_value", "snapshot"]);
  const snapshots = calls.filter((call) => call.name === "snapshot");
  for (const call of snapshots) expect(JSON.parse(call.arguments).app).toBe("Sofia Computer Use Fixture");
  const outputFor = (call: { call_id: string }) => events.find((event) => event?.type === "function_call_output" && event.call_id === call.call_id).output;
  const payloadFor = (call: { call_id: string }) => {
    const text = outputFor(call).find((block: { type: string; text?: string }) => block.type === "input_text" && block.text?.startsWith("{"));
    return JSON.parse(text.text);
  };
  const before = payloadFor(snapshots[0]);
  const after = payloadFor(snapshots[1]);
  const action = calls.find((call) => call.name === "set_value");
  const args = JSON.parse(action.arguments);
  expect(args.snapshot_id).toBe(before.snapshot_id);
  expect(after.snapshot_id).not.toBe(before.snapshot_id);
  expect(payloadFor(action)).toMatchObject({ ok: true, path: "accessibility", fallbackUsed: false, backgroundSafe: true });
  expect(JSON.stringify(before)).not.toContain("Sofia live test 2026-09-28");
  expect(JSON.stringify(after)).toContain("Sofia live test 2026-09-28");
  for (const call of snapshots) expect(outputFor(call).some((block: { type: string }) => block.type === "input_image")).toBe(true);
  expect(events.find((event) => event?.type === "task_complete").error).toBeUndefined();
  evidence.recordAssertionEvidence("Live native input verified from the agent's MCP records", "Only list_apps, two fixture snapshots and set_value were called. AX mutation succeeded without fallback, and a distinct fresh snapshot returned the exact text plus an image.", true);
});
