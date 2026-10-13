import { expect } from "vitest";
import { test } from "@sofia/testkit";
import { useCodexSessionStore } from "../../apps/app/src/react-app/domains/session/codex-session-store";
import { createReconnectRecovery } from "../../apps/app/src/react-app/domains/session/sync/reconnect-recovery";
import { recoverCodexSessions } from "../../apps/app/src/react-app/domains/session/sync/codex-transcript-adapter";
import { getReactQueryClient } from "../../apps/app/src/react-app/infra/query-client";
import { transcriptKey } from "../../apps/app/src/react-app/domains/session/sync/session-sync";
import { syncCodexTranscriptToCache } from "../../apps/app/src/react-app/domains/session/sync/codex-transcript-adapter";
import type { UIMessage } from "ai";
import type { CodexSession } from "../../apps/app/src/app/lib/codex-session";

const session: CodexSession = { id: "codex-recovery", threadId: "recovery", title: "Recovery", workspaceId: "recovery-workspace", created: "2026-10-10", turnId: "turn", status: "idle" };
function seed() {
  const store = useCodexSessionStore.getState();
  store.clear();
  store.upsertSession(session);
  store.upsertItem(session.id, { id: "answer", turnId: "turn", type: "agentMessage", item: { id: "answer", type: "agentMessage", text: "Hello" }, text: "Hello", thinking: "", output: "", status: "pending" });
}

test("reconnect restores missed durable content once without clearing the visible transcript", async () => {
  seed();
  const client = { listSessions: async () => [session], items: async () => ({ ok: true, items: [{ turnId: "turn", item: { id: "answer", type: "agentMessage", text: "Hello world" } }, { turnId: "turn", item: { id: "tool", type: "commandExecution", aggregatedOutput: "done" } }] }) };
  await recoverCodexSessions(client, new AbortController().signal);
  await recoverCodexSessions(client, new AbortController().signal);
  const items = useCodexSessionStore.getState().sessions[session.id].items;
  expect(items.map(item => item.id)).toEqual(["answer", "tool"]);
  expect(items[0]).toMatchObject({ text: "Hello world", status: "done" });
  expect(items[1]).toMatchObject({ output: "done", status: "done" });
});

test("a lagging partial history read cannot erase previously observed interrupted-turn progress", async () => {
  seed();
  const store = useCodexSessionStore.getState();
  store.upsertItem(session.id, { id: "earlier-progress", turnId: "interrupted", historical: true, type: "agentMessage", item: { id: "earlier-progress", type: "agentMessage", text: "Research is underway" }, text: "Research is underway", thinking: "", output: "", status: "done" });
  await recoverCodexSessions({ listSessions: async () => [session], items: async () => ({ ok: true, items: [{ turnId: "turn", item: { id: "answer", type: "agentMessage", text: "Hello" } }] }) }, new AbortController().signal);
  expect(useCodexSessionStore.getState().sessions[session.id].items.find(item => item.id === "earlier-progress")?.text).toBe("Research is underway");
});

test("lagging replay cannot truncate content or restart a completed item", () => {
  seed();
  const store = useCodexSessionStore.getState();
  const original = store.sessions[session.id].items[0];
  store.upsertItem(session.id, { ...original, text: "Hello world", status: "done" });
  store.upsertItem(session.id, original);
  expect(useCodexSessionStore.getState().sessions[session.id].items[0]).toMatchObject({ text: "Hello world", status: "done" });
});

test("cancelled recovery does not mutate sessions after durable item read resolves", async () => {
  seed();
  const controller = new AbortController();
  await recoverCodexSessions({ listSessions: async () => [session], items: async () => { controller.abort(); return { ok: true, items: [{ turnId: "turn", item: { id: "answer", type: "agentMessage", text: "Should not land" } }] }; } }, controller.signal);
  expect(useCodexSessionStore.getState().sessions[session.id].items[0].text).toBe("Hello");
});

test("live status received during reconnect wins over the earlier session list read", async () => {
  seed();
  await recoverCodexSessions({ listSessions: async () => { useCodexSessionStore.getState().upsertSession({ ...session, status: "running", turnId: "new-turn" }); return [session]; }, items: async () => ({ ok: true, items: [] }) }, new AbortController().signal);
  expect(useCodexSessionStore.getState().sessions[session.id].session).toMatchObject({ status: "running", turnId: "new-turn" });
});

 test("durable in-progress tools remain pending and failed tools retain their error state", async () => {
  seed();
  await recoverCodexSessions({ listSessions: async () => [session], items: async () => ({ ok: true, items: [
    { turnId: "turn", item: { id: "running-tool", type: "commandExecution", status: "inProgress", aggregatedOutput: "working" } },
    { turnId: "turn", item: { id: "failed-tool", type: "commandExecution", status: "failed", aggregatedOutput: "failed" } },
  ] }) }, new AbortController().signal);
  expect(useCodexSessionStore.getState().sessions[session.id].items.find(item => item.id === "running-tool")?.status).toBe("pending");
  expect(useCodexSessionStore.getState().sessions[session.id].items.find(item => item.id === "failed-tool")?.status).toBe("error");
});

test("item-only updates during recovery do not retain a stale running session status", async () => {
  seed();
  useCodexSessionStore.getState().upsertSession({ ...session, status: "running" });
  await recoverCodexSessions({ listSessions: async () => {
    useCodexSessionStore.getState().appendItemText(session.id, "answer", " world");
    return [session];
  }, items: async () => ({ ok: true, items: [] }) }, new AbortController().signal);
  expect(useCodexSessionStore.getState().sessions[session.id].session.status).toBe("idle");
  expect(useCodexSessionStore.getState().sessions[session.id].items[0].text).toBe("Hello world");
});


test("ready events during recovery coalesce into one trailing read", async () => {
  let finishFirst = () => {};
  const first = new Promise<void>(resolve => { finishFirst = resolve; });
  let reads = 0;
  let finishTrailing = () => {};
  const trailing = new Promise<void>(resolve => { finishTrailing = resolve; });
  const request = createReconnectRecovery(async () => {
    reads += 1;
    if (reads === 1) await first;
    else finishTrailing();
  }, new AbortController().signal, error => { throw error; });
  request();
  request();
  request();
  expect(reads).toBe(1);
  finishFirst();
  await trailing;
  expect(reads).toBe(2);
});

test("aborting recovery suppresses its pending trailing read", async () => {
  let finish = () => {};
  const pending = new Promise<void>(resolve => { finish = resolve; });
  let reads = 0;
  const controller = new AbortController();
  const request = createReconnectRecovery(async () => { reads += 1; await pending; }, controller.signal, error => { throw error; });
  request();
  request();
  controller.abort();
  finish();
  await pending;
  await Promise.resolve();
  expect(reads).toBe(1);
});


test("status-less active reasoning and messages stay pending until durable idle recovery", async () => {
  seed();
  let currentSession: CodexSession = { ...session, status: "running" };
  const client = { listSessions: async () => [currentSession], items: async () => ({ ok: true, items: [
    { turnId: "turn", item: { id: "answer", type: "agentMessage", text: "Hello world" } },
    { turnId: "turn", item: { id: "reasoning", type: "reasoning", summary: [{ text: "Checking" }] } },
    { turnId: "turn", item: { id: "completed-tool", type: "commandExecution", status: "completed" } },
    { turnId: "turn", item: { id: "declined-tool", type: "commandExecution", status: "declined" } },
  ] }) };
  await recoverCodexSessions(client, new AbortController().signal);
  const active = useCodexSessionStore.getState().sessions[session.id].items;
  expect(active.find(item => item.id === "answer")?.status).toBe("pending");
  expect(active.find(item => item.id === "reasoning")?.status).toBe("pending");
  expect(active.find(item => item.id === "completed-tool")?.status).toBe("done");
  expect(active.find(item => item.id === "declined-tool")?.status).toBe("error");
  currentSession = session;
  await recoverCodexSessions(client, new AbortController().signal);
  const settled = useCodexSessionStore.getState().sessions[session.id].items;
  expect(settled.find(item => item.id === "answer")?.status).toBe("done");
  expect(settled.find(item => item.id === "reasoning")?.status).toBe("done");
});

test("durable cancellation restores missed turn outcome without overwriting live outcomes", async () => {
  seed();
  await recoverCodexSessions({ listSessions: async () => [session], items: async () => ({ ok: true, outcomes: [{ turnId: "turn", outcome: "cancelled" as const }], items: [] }) }, new AbortController().signal);
  expect(useCodexSessionStore.getState().sessions[session.id].items[0]).toMatchObject({ turnOutcome: "cancelled", status: "done" });
  const existing = useCodexSessionStore.getState().sessions[session.id].items[0];
  useCodexSessionStore.getState().upsertItem(session.id, { ...existing, turnOutcome: "failed" });
  await recoverCodexSessions({ listSessions: async () => [session], items: async () => ({ ok: true, outcomes: [{ turnId: "turn", outcome: "completed" as const }], items: [] }) }, new AbortController().signal);
  expect(useCodexSessionStore.getState().sessions[session.id].items[0].turnOutcome).toBe("failed");
});

test("missed cancellation settles an in-progress tool as interrupted rather than successful", async () => {
  seed();
  await recoverCodexSessions({ listSessions: async () => [session], items: async () => ({ ok: true, outcomes: [{ turnId: "turn", outcome: "cancelled" as const }], items: [{ turnId: "turn", item: { id: "tool", type: "commandExecution", status: "inProgress", command: "sleep 10" } }] }) }, new AbortController().signal);
  expect(useCodexSessionStore.getState().sessions[session.id].items.find(item => item.id === "tool")).toMatchObject({ status: "error", turnOutcome: "cancelled" });
});

test("durable user echoes settle missed optimistic acknowledgements without consuming repeated future prompts", async () => {
  seed();
  const store = useCodexSessionStore.getState();
  store.addPendingUserMessage(session.id, "continue", [], undefined, false, 1);
  const oldEcho = { turnId: "old", item: { id: "old-user", type: "userMessage", content: [{ type: "text", text: "continue" }] } };
  await recoverCodexSessions({ listSessions: async () => [session], items: async () => ({ ok: true, items: [oldEcho] }) }, new AbortController().signal);
  expect(useCodexSessionStore.getState().sessions[session.id].pendingUserMessages).toHaveLength(1);
  const newEcho = { turnId: "turn", item: { id: "new-user", type: "userMessage", content: [{ type: "text", text: "continue" }] } };
  await recoverCodexSessions({ listSessions: async () => [session], items: async () => ({ ok: true, items: [oldEcho, newEcho] }) }, new AbortController().signal);
  expect(useCodexSessionStore.getState().sessions[session.id].pendingUserMessages).toHaveLength(0);
});

test("wire text acknowledges attachment display text and unrelated echoes cannot drop pending messages", () => {
  seed();
  const store = useCodexSessionStore.getState();
  store.addPendingUserMessage(session.id, "look [attachment image]", [], "look", true, 0);
  store.confirmPendingUserMessage(session.id, "unrelated", 0);
  expect(useCodexSessionStore.getState().sessions[session.id].pendingUserMessages).toHaveLength(1);
  store.confirmPendingUserMessage(session.id, "look", 0);
  expect(useCodexSessionStore.getState().sessions[session.id].pendingUserMessages).toHaveLength(0);
});


test("unacknowledged user messages stay at submission position and survive a failed turn", () => {
  seed();
  const store = useCodexSessionStore.getState();
  store.addPendingUserMessage(session.id, "new instruction", [], undefined, false, 0);
  store.upsertItem(session.id, { id: "progress", turnId: "turn", type: "agentMessage", item: { id: "progress", type: "agentMessage", text: "Working" }, text: "Working", thinking: "", output: "", status: "pending" });
  syncCodexTranscriptToCache(session.workspaceId, session.id);
  const messages = getReactQueryClient().getQueryData<UIMessage[]>(transcriptKey(session.workspaceId, session.id));
  expect(messages?.map(message => message.id)).toEqual(["codex-item-answer", "codex-user-pending-0", "codex-item-progress"]);
  store.failSession(session.id, "prompt is too long", "turn");
  syncCodexTranscriptToCache(session.workspaceId, session.id);
  expect(useCodexSessionStore.getState().sessions[session.id].pendingUserMessages).toHaveLength(0);
  const failed = getReactQueryClient().getQueryData<UIMessage[]>(transcriptKey(session.workspaceId, session.id));
  expect(failed?.find(message => message.role === "user")?.parts).toEqual([{ type: "text", text: "new instruction", state: "done" }]);
  store.confirmPendingUserMessage(session.id, "new instruction", 0);
  expect(useCodexSessionStore.getState().sessions[session.id].settledUserMessages).toHaveLength(0);
});

test("only a successful durable read makes a restored transcript canonical-ready", async () => {
  seed();
  const store = useCodexSessionStore.getState();
  expect(store.sessions[session.id]?.canonicalReady).not.toBe(true);
  await recoverCodexSessions({ listSessions: async () => [session], items: async () => { throw new Error("offline"); } }, new AbortController().signal);
  expect(useCodexSessionStore.getState().sessions[session.id].canonicalReady).toBe(false);
  await recoverCodexSessions({ listSessions: async () => [session], items: async () => ({ ok: false, items: [] }) }, new AbortController().signal);
  expect(useCodexSessionStore.getState().sessions[session.id].canonicalReady).toBe(false);
  await recoverCodexSessions({ listSessions: async () => [session], items: async () => ({ ok: true, items: [] }) }, new AbortController().signal);
  expect(useCodexSessionStore.getState().sessions[session.id].canonicalReady).toBe(true);
  store.invalidateCanonical(session.id);
  expect(useCodexSessionStore.getState().sessions[session.id].canonicalReady).toBe(false);
});

test("a durable read from an obsolete connection cannot reopen queue admission", async () => {
  seed();
  await recoverCodexSessions({ listSessions: async () => [session], items: async () => {
    useCodexSessionStore.getState().invalidateCanonical(session.id);
    return { ok: true, items: [{ turnId: "turn", item: { id: "obsolete", type: "agentMessage", text: "stale" } }] };
  } }, new AbortController().signal);
  const entry = useCodexSessionStore.getState().sessions[session.id];
  expect(entry.canonicalReady).toBe(false);
  expect(entry.items.some(item => item.id === "obsolete")).toBe(false);
});
