import { expect } from "vitest";
import { test } from "@sofia/testkit";
import { useCodexSessionStore } from "../../apps/app/src/react-app/domains/session/codex-session-store";
import { restoreCodexSessionItems, syncCodexTranscriptToCache } from "../../apps/app/src/react-app/domains/session/sync/codex-transcript-adapter";
import { getReactQueryClient } from "../../apps/app/src/react-app/infra/query-client";
import { transcriptKey } from "../../apps/app/src/react-app/domains/session/sync/session-sync";
import { reconcileRolloutItems } from "../../apps/server/src/codex-rollout-items";

test("rollout aliases and optimistic echoes converge without merging separate repeated prompts", async () => {
  const store = useCodexSessionStore.getState();
  store.clear();
  const id = "codex-alias";
  const workspace = "alias-workspace";
  store.upsertSession({ id, workspaceId: workspace, threadId: "alias", title: "Alias", created: "2026-10-12", status: "idle" });
  const recorded = [{ turnId: "one", item: { id: "recorded-one", type: "userMessage", content: [{ type: "text", text: "continue" }] } }, { turnId: "one", item: { id: "answer", type: "agentMessage", text: "Working" } }, { turnId: "two", item: { id: "recorded-two", type: "userMessage", content: [{ type: "text", text: "continue" }] } }];
  for (const row of recorded) store.upsertItem(id, { id: row.item.id, type: row.item.type, turnId: row.turnId, item: row.item, historical: true, text: row.item.text ?? "", thinking: "", output: "", status: "done" });
  const materialized = [{ turnId: "one", item: { id: "canonical-one", type: "userMessage", content: [{ type: "text", text: "continue" }] } }, { turnId: "two", item: { id: "canonical-two", type: "userMessage", content: [{ type: "text", text: "continue" }] } }];
  const items = reconcileRolloutItems(recorded, materialized);
  expect(items.filter(row => row.item.type === "userMessage").map(row => row.item.id)).toEqual(["canonical-one", "canonical-two"]);
  await restoreCodexSessionItems({ items: async () => ({ ok: true, items }) }, workspace, id);
  await restoreCodexSessionItems({ items: async () => ({ ok: true, items }) }, workspace, id);
  const users = useCodexSessionStore.getState().sessions[id].items.filter(row => row.type === "userMessage");
  expect(users.map(row => row.id)).toEqual(["canonical-one", "canonical-two"]);
  syncCodexTranscriptToCache(workspace, id);
  const messages = getReactQueryClient().getQueryData<Array<{ role: string }>>(transcriptKey(workspace, id));
  expect(messages?.filter(message => message.role === "user")).toHaveLength(2);
});

test("first prompt converges from live echo and rollout despite injected startup context", async () => {
  const store = useCodexSessionStore.getState();
  store.clear();
  const id = "codex-first-prompt";
  const workspace = "first-prompt-workspace";
  store.upsertSession({ id, workspaceId: workspace, threadId: "first-prompt", title: "", created: "2026-10-20", status: "idle" });
  const recorded = [
    { turnId: "first", item: { id: "context", type: "userMessage", content: [{ type: "text", text: "# AGENTS.md instructions for /project\n\n<INSTRUCTIONS>\nProject instructions\n</INSTRUCTIONS>\n<environment_context>\n<cwd>/project</cwd>\n</environment_context>" }] } },
    { turnId: "first", item: { id: "rollout-user", type: "userMessage", content: [{ type: "text", text: "hii" }] } },
    { turnId: "first", item: { id: "answer", type: "agentMessage", text: "Hey!" } },
  ];
  store.addPendingUserMessage(id, "hii", [], "hii", false, 0);
  for (const row of recorded) store.upsertItem(id, { id: row.item.id, type: row.item.type, turnId: row.turnId, item: row.item, text: row.item.text ?? "", thinking: "", output: "", status: "done" });
  // The live protocol ID differs from the response_item ID in the rollout.
  const materialized = [
    { turnId: "first", item: { id: "live-user", type: "userMessage", content: [{ type: "text", text: "hii" }] } },
    { turnId: "first", item: { id: "answer", type: "agentMessage", text: "Hey!" } },
  ];
  store.upsertItem(id, { id: "live-user", type: "userMessage", turnId: "first", item: materialized[0].item, text: "", thinking: "", output: "", status: "done" });
  const items = reconcileRolloutItems(recorded, materialized);
  expect(items[1].item).toMatchObject({ id: "live-user", recordedItemId: "rollout-user" });
  await restoreCodexSessionItems({ items: async () => ({ ok: true, items }) }, workspace, id);
  await restoreCodexSessionItems({ items: async () => ({ ok: true, items }) }, workspace, id);
  expect(useCodexSessionStore.getState().sessions[id].pendingUserMessages).toEqual([]);
  const messages = getReactQueryClient().getQueryData<Array<{ role: string }>>(transcriptKey(workspace, id));
  expect(messages?.map(message => message.role)).toEqual(["user", "assistant"]);
});

test("repeated identical prompts in one turn retain occurrence identity around context", () => {
  const user = (id: string, text = "hii") => ({ turnId: "first", item: { id, type: "userMessage", content: [{ type: "text", text }] } });
  const recorded = [user("context", "<environment_context>context</environment_context>"), user("raw-one"), user("raw-two"), { turnId: "first", item: { id: "answer", type: "agentMessage", text: "Hey!" } }];
  expect(reconcileRolloutItems(recorded, [user("live-one"), user("live-two")]).map(row => row.item.id)).toEqual(["context", "live-one", "live-two", "answer"]);
  // A partial materialized read cannot establish which identical occurrence it contains.
  expect(reconcileRolloutItems(recorded, [user("live-two")]).map(row => row.item.id)).toEqual(["context", "raw-one", "raw-two", "answer"]);
});
