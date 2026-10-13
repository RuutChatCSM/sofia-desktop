import { expect } from "vitest";
import { test } from "@sofia/testkit";
import { parseRolloutItems } from "../../apps/server/src/codex-rollout-items";
const record = (payload: object, timestamp = "2026-10-11T00:00:00Z", type = "response_item") => JSON.stringify({ type, timestamp, payload });

test("durable imported transcript keeps commentary, image sources, reasoning summary and real clocks", () => {
  const items = parseRolloutItems([
    record({ turn_id: "turn-one" }, undefined, "turn_context"),
    record({ type: "message", role: "user", content: [{ type: "input_text", text: "Inspect this" }, { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" }] }),
    record({ type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "I will inspect it." }] }),
    record({ type: "reasoning", summary: [{ type: "summary_text", text: "Visible summary" }], content: [] }),
    record({ type: "message", role: "assistant", phase: "final_answer", content: [{ text: "Done" }] }, "2026-10-11T00:00:10Z"),
  ].join("\n"));
  expect(items).toHaveLength(4);
  expect(items[0].item.content).toEqual([{ type: "text", text: "Inspect this" }, { type: "image", url: "data:image/png;base64,aGVsbG8=" }]);
  expect(items[1].item.phase).toBe("commentary");
  expect(items[2].item.summary).toEqual([{ type: "summary_text", text: "Visible summary" }]);
  expect(Number(items[3].item.completedAt) - Number(items[0].item.createdAt)).toBe(10000);
});

test("function and custom outputs update original named call without generic duplicate", () => {
  const items = parseRolloutItems([
    record({ type: "function_call", call_id: "call-one", name: "collaboration.send_message", arguments: '{"target":"agent","message":"hello"}' }),
    record({ type: "function_call_output", call_id: "call-one", output: "delivered" }, "2026-10-11T00:00:03Z"),
    record({ type: "custom_tool_call", call_id: "call-two", name: "other_custom", input: "value" }),
    record({ type: "custom_tool_call_output", call_id: "call-two", output: "result" }),
    record({ type: "function_call_output", call_id: "orphan", output: "unknown" }),
  ].join("\n"));
  expect(items).toHaveLength(2);
  expect(items[0].item).toMatchObject({ id: "call-one", tool: "collaboration.send_message", arguments: { target: "agent", message: "hello" }, result: "delivered", completedAt: Date.parse("2026-10-11T00:00:03Z") });
  expect(items[1].item).toMatchObject({ tool: "other_custom", result: "result" });
});

test("historical hydration renders imported images and omits unknown clocks", async () => {
  const { restoreCodexSessionItems } = await import("../../apps/app/src/react-app/domains/session/sync/codex-transcript-adapter");
  const { useCodexSessionStore } = await import("../../apps/app/src/react-app/domains/session/codex-session-store");
  const { getReactQueryClient } = await import("../../apps/app/src/react-app/infra/query-client");
  const { transcriptKey } = await import("../../apps/app/src/react-app/domains/session/sync/session-sync");
  const session = { id: "codex-import-fidelity", threadId: "import-fidelity", title: "Import", workspaceId: "import-workspace", created: "2026-10-11", status: "idle" as const };
  useCodexSessionStore.getState().upsertSession(session);
  await restoreCodexSessionItems({ items: async () => ({ ok: true, items: [
    { turnId: "one", item: { id: "user", type: "userMessage", content: [{ type: "image", url: "data:image/png;base64,aGVsbG8=" }] } },
    { turnId: "one", item: { id: "answer", type: "agentMessage", text: "Done", phase: "final_answer" } },
  ] }) }, session.workspaceId, session.id);
  const messages = getReactQueryClient().getQueryData<Array<{ parts: unknown[]; metadata: { local: object } }>>(transcriptKey(session.workspaceId, session.id));
  expect(messages?.[0].parts).toEqual([{ type: "file", mediaType: "image/png", url: "data:image/png;base64,aGVsbG8=" }]);
  expect(messages?.[1].metadata.local).toEqual({});
});

test("canonical root narrative replaces partial child-contaminated materialization", async () => {
  const { reconcileRolloutItems } = await import("../../apps/server/src/codex-rollout-items");
  const root = parseRolloutItems([
    record({ turn_id: "root-turn" }, undefined, "turn_context"),
    record({ type: "message", role: "user", content: [{ text: "do all those" }] }),
    record({ type: "message", role: "assistant", phase: "commentary", content: [{ text: "I will work through all four" }] }),
    record({ type: "function_call", call_id: "call", name: "spawn_agent", arguments: '{}' }),
    record({ type: "message", role: "assistant", phase: "final_answer", content: [{ text: "All four completed" }] }),
  ].join("\n"));
  const restored = reconcileRolloutItems(root, [{ turnId: "root-turn", item: { id: "child-final", type: "agentMessage", text: "Visual renderer pass complete" } }]);
  expect(restored).toEqual(root);
  expect(restored.some(entry => entry.item.text === "Visual renderer pass complete")).toBe(false);
  expect(restored.filter(entry => entry.item.type === "agentMessage").map(entry => entry.item.phase)).toEqual(["commentary", "final_answer"]);
});

test("turn outcomes retain complete work interval instead of final-message duration", async () => {
  const { parseDurableTurnOutcomes } = await import("../../apps/server/src/codex-turn-outcomes");
  const outcomes = parseDurableTurnOutcomes([
    record({ type: "task_started", turn_id: "root" }, "2026-10-11T00:31:44.526Z", "event_msg"),
    record({ type: "task_complete", turn_id: "root" }, "2026-10-11T00:55:35.562Z", "event_msg"),
  ].join("\n"));
  expect(outcomes[0].startedAt).toBe(Date.parse("2026-10-11T00:31:44.526Z"));
  expect(Number(outcomes[0].completedAt) - Number(outcomes[0].startedAt)).toBe(1431036);
});
