import { expect } from "vitest";
import { test } from "@sofia/testkit";
import { useCodexSessionStore } from "../../apps/app/src/react-app/domains/session/codex-session-store";
import type { CodexTrackedItem } from "../../apps/app/src/react-app/domains/session/codex-session-store";
import type { CodexSession } from "../../apps/app/src/app/lib/codex-session";

function session(id: string, status: CodexSession["status"] = "idle"): CodexSession {
  return { id: `codex-${id}`, threadId: id, title: `Task ${id}`, workspaceId: "transcript-eviction", created: "2026-11-01", turnId: `turn-${id}`, status };
}

function transcriptItem(sessionId: string): CodexTrackedItem {
  return {
    id: `${sessionId}:item`,
    turnId: "turn",
    type: "agentMessage",
    item: { id: `${sessionId}:item`, type: "agentMessage", text: "Hello" },
    text: "Hello",
    thinking: "",
    output: "",
    status: "done",
  };
}

function seed(target: CodexSession) {
  const store = useCodexSessionStore.getState();
  store.upsertSession(target);
  store.upsertItem(target.id, transcriptItem(target.id));
  store.applyDelta(target.id, "Hello");
  store.setPlan(target.id, [{ step: "Finish", status: "completed" }]);
  useCodexSessionStore.setState(state => {
    const entry = state.sessions[target.id];
    if (!entry) return state;
    return { sessions: { ...state.sessions, [target.id]: { ...entry, canonicalReady: true, canonicalEpoch: 0 } } };
  });
}

test("transcript eviction keeps the active and recent sessions, running and optimistic ones", () => {
  const store = useCodexSessionStore.getState();
  store.clear();

  const running = session("running", "running");
  const pending = session("pending");
  const warned = session("warned");
  const opened = Array.from({ length: 8 }, (_, index) => session(`opened-${index + 1}`));
  for (const target of [running, pending, warned]) {
    seed(target);
    store.noteSessionOpened(target.id);
  }
  store.addPendingUserMessage(pending.id, "Still sending");
  store.setWarning(warned.id, "Held by another window");
  for (const target of opened) {
    seed(target);
    store.noteSessionOpened(target.id);
  }

  const state = useCodexSessionStore.getState();
  expect(state.recentSessionIds).toEqual(opened.slice(1).reverse().map(target => target.id));

  const evicted = state.sessions[opened[0].id];
  expect(evicted.session.title).toBe(opened[0].title);
  expect(evicted.items).toHaveLength(0);
  expect(evicted.messages).toHaveLength(0);
  expect(evicted.plan).toBeUndefined();
  expect(evicted.canonicalReady).toBe(false);
  expect(evicted.canonicalEpoch).toBe(1);

  for (const protectedSession of [running, pending, warned]) {
    const entry = state.sessions[protectedSession.id];
    expect(entry.items).toHaveLength(1);
    expect(entry.messages).toHaveLength(1);
    expect(entry.canonicalReady).toBe(true);
  }

  const active = state.sessions[opened[opened.length - 1].id];
  expect(active.items).toHaveLength(1);
  expect(active.canonicalReady).toBe(true);
});
