import { expect } from "vitest";
import { test } from "@sofia/testkit";
import { mergeCanonicalItemOrder } from "../../apps/app/src/react-app/domains/session/sync/canonical-item-order";
import { buildSofiaDeveloperInstructions } from "../../apps/server/src/codex-prompt-harness";

test("completion history missing a live request cannot move the answer above it", () => {
  const live = [{ id: "previous-answer" }, { id: "request" }, { id: "commentary" }, { id: "tool" }, { id: "answer" }];
  const partial = [live[0], live[3], live[4]];
  const completed = mergeCanonicalItemOrder(live, partial);
  expect(completed.map(item => item.id)).toEqual(live.map(item => item.id));
  expect(mergeCanonicalItemOrder(completed, live)).toEqual(live);
});

test("canonical recovery inserts missing history without moving anchored live work to the end", () => {
  const live = [{ id: "request" }, { id: "live-commentary" }, { id: "answer" }, { id: "next-request" }];
  const canonical = [{ id: "request" }, { id: "recorded-tool" }, { id: "answer" }];
  expect(mergeCanonicalItemOrder(live, canonical).map(item => item.id)).toEqual(["request", "recorded-tool", "live-commentary", "answer", "next-request"]);
});

test("delegation guidance gives independent task examples without requiring unnecessary agents", () => {
  const prompt = buildSofiaDeveloperInstructions({ workspaceId: "test", cwd: "/tmp" });
  expect(prompt).toContain("callable subagent tools");
  expect(prompt).toContain("frontend and server investigation");
  expect(prompt).toContain("Keep simple edits");
  expect(prompt).toContain("successful tool result");
});

test("actual completion hydration and reload keep the request before its final answer", async () => {
  const { useCodexSessionStore } = await import("../../apps/app/src/react-app/domains/session/codex-session-store");
  const { restoreCodexSessionItems, syncCodexTranscriptToCache } = await import("../../apps/app/src/react-app/domains/session/sync/codex-transcript-adapter");
  const { getReactQueryClient } = await import("../../apps/app/src/react-app/infra/query-client");
  const { transcriptKey } = await import("../../apps/app/src/react-app/domains/session/sync/session-sync");
  const store = useCodexSessionStore.getState();
  store.clear();
  const id = "codex-completion-order";
  const workspace = "completion-workspace";
  const session = { id, workspaceId: workspace, threadId: "completion-order", title: "Order", created: "2026-10-12", status: "running" as const, turnId: "turn" };
  store.upsertSession(session);
  const rows = [
    { turnId: "turn", item: { id: "request", type: "userMessage", content: [{ type: "text", text: "My request" }] } },
    { turnId: "turn", item: { id: "progress", type: "agentMessage", text: "Investigating", phase: "commentary" } },
    { turnId: "turn", item: { id: "answer", type: "agentMessage", text: "Final answer", phase: "final_answer" } },
  ];
  for (const row of rows) store.upsertItem(id, { id: row.item.id, type: row.item.type, turnId: row.turnId, item: row.item, text: row.item.text ?? "", thinking: "", output: "", status: "done" });
  store.upsertSession({ ...session, status: "idle" });
  await restoreCodexSessionItems({ items: async () => ({ ok: true, items: [rows[2]] }) }, workspace, id);
  expect(useCodexSessionStore.getState().sessions[id].items.map(item => item.id)).toEqual(["request", "progress", "answer"]);
  await restoreCodexSessionItems({ items: async () => ({ ok: true, items: rows }) }, workspace, id);
  syncCodexTranscriptToCache(workspace, id);
  const messages = getReactQueryClient().getQueryData<Array<{ role: string; parts: Array<{ type: string; text?: string }> }>>(transcriptKey(workspace, id));
  expect(messages?.map(message => [message.role, message.parts.filter(part => part.type === "text").map(part => part.text).join("")])).toEqual([["user", "My request"], ["assistant", "Investigating"], ["assistant", "Final answer"]]);
});
