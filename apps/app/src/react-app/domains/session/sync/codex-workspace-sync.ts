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
    // A resumed stream replayed every missed event; only a fresh one needs
    // the list and open transcripts re-read.
    if (event.type === "stream.ready" && !event.replayed) requestRecovery();
    if (event.type === "turn.completed" || event.type === "error") requestSessionHistory(event.sessionId);
  }, workspaceId);
  const hydrate = async () => {
    try {
      const snapshot = useCodexSessionStore.getState().sessions;
      const list = (await client.listSessions()).map(session => ({ ...session, workspaceId }));
      if (signal.aborted) return;
      store.replaceSessions(list, { workspaceId, entries: snapshot });
      onListResolved({ status: "ready", error: null });
      // Older servers have no archived listing; the section just stays empty.
      const archived = await client.listArchivedSessions().catch(() => []);
      if (signal.aborted) return;
      for (const session of archived) {
        if (!useCodexSessionStore.getState().sessions[session.id]) store.upsertSession({ ...session, workspaceId, archived: true });
      }
      // History is read when a task is opened (ensureCodexTranscriptCached).
      // Reading every transcript here queued hundreds of reads ahead of the
      // one the user clicked and stalled the server on large rollouts.
    } catch {
      if (signal.aborted) return;
      onListResolved({ status: "error", error: "Unable to load tasks. Reconnect the workspace and try again." });
      store.setError("Failed to load codex sessions");
    }
  };
  await Promise.all([stream, hydrate()]);
}
