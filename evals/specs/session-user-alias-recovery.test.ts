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
