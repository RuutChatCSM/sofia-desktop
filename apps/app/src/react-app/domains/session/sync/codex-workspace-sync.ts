import type { CodexSessionClient } from "@/app/lib/codex-session";
import { runCodexStream, useCodexSessionStore } from "../codex-session-store";
import { recoverCodexSessions, restoreCodexSessionItems } from "./codex-transcript-adapter";
import { createReconnectRecovery, createSessionHistoryRecovery } from "./reconnect-recovery";

type SessionListResolution = { status: "ready" | "error"; error: string | null };

/** Keep workspace events live independently of initial list/history reads. */
export async function syncCodexWorkspace(
  client: CodexSessionClient,
  workspaceId: string,
  signal: AbortSignal,
  onListResolved: (resolution: SessionListResolution) => void,
): Promise<void> {
  const store = useCodexSessionStore.getState();
  const requestRecovery = createReconnectRecovery(
    () => recoverCodexSessions(client, signal, workspaceId), signal,
    error => store.setError(error instanceof Error ? error.message : "Failed to recover sessions"),
  );
  const requestSessionHistory = createSessionHistoryRecovery(async sessionId => {
    const entry = useCodexSessionStore.getState().sessions[sessionId];
    if (entry) await restoreCodexSessionItems(client, entry.session.workspaceId, sessionId, signal);
  }, signal, error => store.setError(error instanceof Error ? error.message : "Failed to recover thread history"));
  // Subscribe before loading history: a slow old transcript must not block
  // newly created tasks, their first-message titles, or completion events.
  const stream = runCodexStream(client, signal, event => {
    if (event.type === "stream.ready") requestRecovery();
    if (event.type === "turn.completed" || event.type === "error") requestSessionHistory(event.sessionId);
  }, workspaceId);
  const hydrate = async () => {
    try {
      const snapshot = useCodexSessionStore.getState().sessions;
      const list = (await client.listSessions()).map(session => ({ ...session, workspaceId }));
      if (signal.aborted) return;
      store.replaceSessions(list, { workspaceId, entries: snapshot });
      onListResolved({ status: "ready", error: null });
      await Promise.all(list.map(session => restoreCodexSessionItems(client, workspaceId, session.id, signal)));
    } catch {
      if (signal.aborted) return;
      onListResolved({ status: "error", error: "Unable to load tasks. Reconnect the workspace and try again." });
      store.setError("Failed to load codex sessions");
    }
  };
  await Promise.all([stream, hydrate()]);
}
