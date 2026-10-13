import { expect } from "vitest";
import { test } from "@sofia/testkit";
import { useCodexSessionStore } from "../../apps/app/src/react-app/domains/session/codex-session-store";
import type { CodexSession } from "../../apps/app/src/app/lib/codex-session";
const session = (id: string, workspaceId: string): CodexSession => ({ id, workspaceId, threadId: id, title: id, created: "2026-10-12", status: "idle" });
test("workspace snapshot preserves sessions in other workspaces", () => {
  const store = useCodexSessionStore.getState();
  store.clear();
  store.upsertSession(session("a", "tools"));
  store.replaceSessions([session("b", "tween")]);
  expect(Object.values(useCodexSessionStore.getState().sessions).map(entry => entry.session.workspaceId)).toEqual(["tools", "tween"]);
});
test("late pre-create snapshot cannot remove newly accepted task", () => {
  const store = useCodexSessionStore.getState();
  store.clear();
  store.upsertSession(session("new", "tools"));
  store.replaceSessions([]);
  expect(useCodexSessionStore.getState().sessions.new.session.title).toBe("new");
  store.replaceSessions([{ ...session("new", "tools"), title: "Named task", archived: true }]);
  expect(useCodexSessionStore.getState().sessions.new.session).toMatchObject({ title: "Named task", archived: true });
});

test("fresh missing snapshot removes only unchanged rows in its workspace", () => {
  const store = useCodexSessionStore.getState();
  store.clear();
  store.upsertSession(session("old", "tools"));
  store.upsertSession(session("other", "tween"));
  const entries = useCodexSessionStore.getState().sessions;
  store.upsertSession(session("new", "tools"));
  store.replaceSessions([], { workspaceId: "tools", entries });
  expect(Object.keys(useCodexSessionStore.getState().sessions)).toEqual(["other", "new"]);
  store.replaceSessions([], { workspaceId: "tools", entries: useCodexSessionStore.getState().sessions });
  expect(Object.keys(useCodexSessionStore.getState().sessions)).toEqual(["other"]);
});
test("missing snapshot preserves a row updated while the request was pending", () => {
  const store = useCodexSessionStore.getState();
  store.clear();
  store.upsertSession(session("edited", "tools"));
  const entries = useCodexSessionStore.getState().sessions;
  store.upsertSession({ ...session("edited", "tools"), title: "Renamed" });
  store.replaceSessions([], { workspaceId: "tools", entries });
  expect(useCodexSessionStore.getState().sessions.edited.session.title).toBe("Renamed");
});

test("snapshot cannot overwrite newer session metadata", () => {
  const store = useCodexSessionStore.getState();
  store.clear();
  store.upsertSession(session("renamed", "tools"));
  const entries = useCodexSessionStore.getState().sessions;
  store.upsertSession({ ...session("renamed", "tools"), title: "New title" });
  store.replaceSessions([session("renamed", "tools")], { workspaceId: "tools", entries });
  expect(useCodexSessionStore.getState().sessions.renamed.session.title).toBe("New title");
});
