import { expect } from "vitest";
import { test } from "@sofia/testkit";
import { createCodexSessionClient, type CodexEvent, type CodexSession } from "../../apps/app/src/app/lib/codex-session";
import { useCodexSessionStore } from "../../apps/app/src/react-app/domains/session/codex-session-store";
import { syncCodexWorkspace } from "../../apps/app/src/react-app/domains/session/sync/codex-workspace-sync";

for (const blockedRead of ["list", "history"]) {
  test(`new session and first-message title update while ${blockedRead} loading is blocked`, async () => {
    const store = useCodexSessionStore.getState();
    store.clear();
    const controller = new AbortController();
    let releaseRead = () => {};
    const blocked = new Promise<void>(resolve => { releaseRead = resolve; });
    let emit: ((event: CodexEvent) => void) | undefined;
    let historyRequested = false;
    const session: CodexSession = { id: "codex-startup", threadId: "startup", workspaceId: "server-workspace", title: "", created: "2026-10-20", status: "idle" };
    const oldSession = { ...session, id: "codex-old", threadId: "old" };
    const client = {
      ...createCodexSessionClient({ baseUrl: "http://unused", token: "unused", workspaceId: "server-workspace" }),
      listSessions: async () => {
        if (blockedRead === "list") await blocked;
        return [oldSession];
      },
      items: async () => {
        historyRequested = true;
        if (blockedRead === "history") await blocked;
        return { ok: true, items: [] };
      },
      stream: async (signal: AbortSignal, onEvent: (event: CodexEvent) => void) => {
        emit = onEvent;
        await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
      },
    };
    const sync = syncCodexWorkspace(client, "display-workspace", controller.signal, () => {});
    try {
      if (blockedRead === "history") await expect.poll(() => historyRequested).toBe(true);
      expect(emit).toBeTypeOf("function");
      emit?.({ type: "session.created", session });
      expect(useCodexSessionStore.getState().sessions[session.id].session.workspaceId).toBe("display-workspace");
      emit?.({ type: "session.updated", session: { ...session, title: "hii", status: "running", turnId: "first" } });
      expect(useCodexSessionStore.getState().sessions[session.id].session).toMatchObject({ title: "hii", status: "running" });
      releaseRead();
      await expect.poll(() => historyRequested).toBe(true);
      expect(useCodexSessionStore.getState().sessions[session.id].session.title).toBe("hii");
    } finally {
      controller.abort();
      releaseRead();
      await sync;
      store.clear();
    }
  });
}

test("a delayed reconnect list cannot overwrite a first-message title received live", async () => {
  const { recoverCodexSessions } = await import("../../apps/app/src/react-app/domains/session/sync/codex-transcript-adapter");
  const store = useCodexSessionStore.getState();
  store.clear();
  const session: CodexSession = { id: "codex-title-race", threadId: "title-race", workspaceId: "workspace", title: "", created: "2026-10-20", status: "idle" };
  store.upsertSession(session);
  let releaseList = () => {};
  const blocked = new Promise<void>(resolve => { releaseList = resolve; });
  const recovery = recoverCodexSessions({
    listSessions: async () => { await blocked; return [session]; },
    items: async () => ({ ok: true, items: [] }),
  }, new AbortController().signal, "workspace");
  store.upsertSession({ ...session, title: "hii" });
  releaseList();
  await recovery;
  expect(useCodexSessionStore.getState().sessions[session.id].session.title).toBe("hii");
  store.clear();
});
