/** @jsxImportSource react */
import { useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { createCodexSessionClient, isThreadWriterConflictError, type CodexEngineConfigWire } from "@/app/lib/codex-session";
import { setCodexAbortHandler, setCodexForkHandler } from "@/app/lib/engine-session";
import { refreshBackgroundProcesses, runCodexStream, setCodexClient, useCodexSessionStore } from "./codex-session-store";
import { syncCodexTranscriptToCache, restoreCodexSessionItems, ensureCodexTranscriptCached, recoverCodexSessions } from "./sync/codex-transcript-adapter";
import { createReconnectRecovery, createSessionHistoryRecovery } from "./sync/reconnect-recovery";
import { changedSessionIds } from "./sync/transcript-mirror";
import { subscribeSentAttachments, whenSentAttachmentsReady } from "./sync/sent-attachment-store";
import { useCodexAttentionFeed } from "./use-codex-attention";

export type CodexEngineEndpoint = {
  baseUrl: string;
  token: string;
  hostToken?: string;
  workspaceId: string;
  displayWorkspaceId?: string;
};

/**
 * Wires the Sofia session store to a workspace's engine: loads existing
 * sessions and opens the SSE stream. Sofia is the only engine, so this
 * activates whenever a workspace endpoint is available.
 */
export function useCodexEngine(endpoint: CodexEngineEndpoint | null, activeSessionId?: string | null) {
  const enabled = Boolean(endpoint);
  const displayWorkspaceId = endpoint?.displayWorkspaceId ?? endpoint?.workspaceId;
  const endpointRef = useRef<CodexEngineEndpoint | null>(endpoint);
  endpointRef.current = endpoint;

  const client = useMemo(() => {
    if (!enabled || !endpoint) return null;
    return createCodexSessionClient({
      baseUrl: endpoint.baseUrl,
      token: endpoint.token,
      hostToken: endpoint.hostToken,
      workspaceId: endpoint.workspaceId,
    });
  }, [enabled, endpoint?.baseUrl, endpoint?.hostToken, endpoint?.token, endpoint?.workspaceId]);

  const [sessionListResolution, setSessionListResolution] = useState<{ client: typeof client; status: "ready" | "error"; error: string | null } | null>(null);
  const [engineConfig, setEngineConfig] = useState<CodexEngineConfigWire | null>(null);
  const [configVersion, setConfigVersion] = useState(0);
  useEffect(() => {
    const refresh = () => setConfigVersion((value) => value + 1);
    window.addEventListener("sofia:codex-providers-changed", refresh);
    return () => window.removeEventListener("sofia:codex-providers-changed", refresh);
  }, []);
  useEffect(() => {
    if (!enabled || !client) {
      setEngineConfig(null);
      return;
    }
    let cancelled = false;
    void client.config().then((result) => {
      if (!cancelled) setEngineConfig(result.config);
    }).catch(() => {
      if (!cancelled) setEngineConfig(null);
    });
    return () => { cancelled = true; };
  }, [enabled, client, configVersion]);

  // Route shared stop/abort actions for codex sessions to the codex engine.
  useEffect(() => {
    if (!enabled || !client) {
      setCodexAbortHandler(null);
      return;
    }
    setCodexAbortHandler(async (sessionId) => {
      try {
        await client.abort(sessionId);
        return true;
      } catch {
        return false;
      }
    });
    return () => setCodexAbortHandler(null);
  }, [enabled, client]);

  // Route "Branch in new chat" for codex sessions to the codex engine.
  useEffect(() => {
    if (!enabled || !client) {
      setCodexForkHandler(null);
      return;
    }
    setCodexForkHandler(async (sessionId, messageId) => {
      const result = await client.forkSession(sessionId, messageId);
      result.session.workspaceId = displayWorkspaceId ?? result.session.workspaceId;
      useCodexSessionStore.getState().upsertSession(result.session);
      return { id: result.session.id };
    });
    return () => setCodexForkHandler(null);
  }, [enabled, client, displayWorkspaceId]);

  useEffect(() => {
    const store = useCodexSessionStore.getState();
    if (!enabled || !client || !displayWorkspaceId) {
      store.setStreaming(false);
      return;
    }
    const controller = new AbortController();
    // Mirror every codex session's transcript into the shared react-query
    // cache (transcriptKey/statusKey) so the existing MessageList renders
    // codex sessions with no surface-specific code. Coalesce to one cache
    // write per animation frame — long streams otherwise rebuild the whole
    // transcript per delta and starve the main thread (the same freeze the
    // engine sync guards against).
    let mirrorFrame: number | null = null;
    // Only sessions whose entry actually changed are re-serialized. Rebuilding
    // *every* session's full transcript once per frame (the previous behaviour)
    // made the cost grow with total history, not with the change: one long
    // conversation, or a busy session beside a long one, pinned the main thread
    // and the app froze — including on a single revert, which fans out into a
    // burst of store updates.
    const dirtySessions = new Set<string>();
    const scheduleMirror = () => {
      if (mirrorFrame !== null) return;
      mirrorFrame = requestAnimationFrame(() => {
        mirrorFrame = null;
        const sessionIds = [...dirtySessions];
        dirtySessions.clear();
        const sessions = useCodexSessionStore.getState().sessions;
        for (const sessionId of sessionIds) {
          const entry = sessions[sessionId];
          if (entry) syncCodexTranscriptToCache(entry.session.workspaceId, sessionId);
        }
      });
    };
    const mirror = (
      state: ReturnType<typeof useCodexSessionStore.getState>,
      previous: ReturnType<typeof useCodexSessionStore.getState>,
    ) => {
      for (const sessionId of changedSessionIds(state.sessions, previous.sessions)) {
        dirtySessions.add(sessionId);
      }
      if (dirtySessions.size) scheduleMirror();
    };
    const unsubscribe = useCodexSessionStore.subscribe(mirror);
    // Sent attachments hydrate asynchronously after boot (IndexedDB). Rebuild
    // every transcript once they land, or a reopened session shows no images
    // until something else happens to change it.
    const unsubscribeAttachments = subscribeSentAttachments(() => {
      for (const sessionId of Object.keys(useCodexSessionStore.getState().sessions)) {
        dirtySessions.add(sessionId);
      }
      if (dirtySessions.size) scheduleMirror();
    });
    void whenSentAttachmentsReady();
    // Background-process UI (footer/list/stop) needs the same client the stream
    // uses; the store owns the registry so it stays in sync with this effect.
    if (displayWorkspaceId) setCodexClient(displayWorkspaceId, client);
    void (async () => {
      try {
        const snapshot = useCodexSessionStore.getState().sessions;
        const list = (await client.listSessions()).map((session) => ({ ...session, workspaceId: displayWorkspaceId ?? session.workspaceId }));
        if (controller.signal.aborted) return;
        store.replaceSessions(list, { workspaceId: displayWorkspaceId, entries: snapshot });
        setSessionListResolution({ client, status: "ready", error: null });
        // Restore persisted items so existing sessions show their transcript
        // (tools, reasoning) on open — not just live streams.
        await Promise.all(
          list.map((session) => restoreCodexSessionItems(client, session.workspaceId, session.id, controller.signal)),
        );
      } catch {
        if (controller.signal.aborted) return;
        setSessionListResolution({ client, status: "error", error: "Unable to load tasks. Reconnect the workspace and try again." });
        store.setError("Failed to load codex sessions");
      }
      const requestRecovery = createReconnectRecovery(
        () => recoverCodexSessions(client, controller.signal, displayWorkspaceId),
        controller.signal,
        (error) => store.setError(error instanceof Error ? error.message : "Failed to recover sessions"),
      );
      const requestSessionHistory = createSessionHistoryRecovery(async sessionId => {
        const entry = useCodexSessionStore.getState().sessions[sessionId];
        if (entry) await restoreCodexSessionItems(client, entry.session.workspaceId, sessionId, controller.signal);
      }, controller.signal, error => store.setError(error instanceof Error ? error.message : "Failed to recover thread history"));
      if (!controller.signal.aborted) await runCodexStream(client, controller.signal, (event) => {
        if (event.type === "stream.ready") requestRecovery();
        if (event.type === "turn.completed" || event.type === "error") requestSessionHistory(event.sessionId);
      }, displayWorkspaceId);
    })();
    return () => {
      if (displayWorkspaceId) setCodexClient(displayWorkspaceId, null);
      controller.abort();
      if (mirrorFrame !== null) cancelAnimationFrame(mirrorFrame);
      unsubscribe();
      unsubscribeAttachments();
    };
  }, [enabled, client, displayWorkspaceId]);

  // The mount-time restore above is not enough on its own: its cache entries
  // have no observer, so TanStack GC drops them after the transcript/status
  // gcTime and opening a task later rendered a blank pane with no way back.
  // Re-seed the active task's transcript on open instead of trusting a
  // one-shot write that may already be gone.
  useEffect(() => {
    if (!client || !activeSessionId?.startsWith("codex-")) return;
    const entry = useCodexSessionStore.getState().sessions[activeSessionId];
    const workspaceId = displayWorkspaceId ?? entry?.session.workspaceId;
    if (!workspaceId) return;
    void ensureCodexTranscriptCached(client, workspaceId, activeSessionId);
    // Opening a task reconciles background processes: the renderer's cache is
    // transient, the server registry is authoritative.
    void refreshBackgroundProcesses(activeSessionId);
  }, [activeSessionId, client, displayWorkspaceId]);

  // All store hooks must run at the top with stable selectors; a selector that
  // builds a new array each call makes useSyncExternalStore loop forever.
  const workspaceId = displayWorkspaceId;

  // Cross-workspace attention: the server observes every workspace it manages,
  // so a background failure is surfaced (attention + notification) even while
  // the window shows another workspace.
  useCodexAttentionFeed(
    enabled && endpoint ? { baseUrl: endpoint.baseUrl, token: endpoint.token, hostToken: endpoint.hostToken } : null,
  );
  const sessions = useCodexSessionStore(
    useShallow((state) =>
      Object.values(state.sessions)
        .filter((entry) => entry.session.workspaceId === workspaceId && !entry.session.archived && !entry.session.parentSessionId)
        .map((entry) => entry.session),
    ),
  );
  const selectedEntry=useCodexSessionStore(state=>activeSessionId?state.sessions[activeSessionId]:undefined);
  // External workers can start or finish without a parent transcript event.
  useEffect(() => {
    if (!client || !activeSessionId?.startsWith("codex-")) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        if (document.visibilityState !== "hidden") {
          const result = await client.subagents(activeSessionId);
          if (!cancelled && result.ok) useCodexSessionStore.setState(state => {
            const entry = state.sessions[activeSessionId];
            return entry ? { sessions: { ...state.sessions, [activeSessionId]: { ...entry, subagentSessions: result.sessions } } } : state;
          });
        }
      } catch { /* Keep the last recorded status during connection loss. */ }
      if (!cancelled) timer = setTimeout(refresh, 3000);
    };
    void refresh();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [client, activeSessionId]);
  const loaded=useCodexSessionStore(state=>state.loaded);
  const [recoveredParent,setRecoveredParent]=useState<{child:string;parent:string}|null>(null);
  useEffect(()=>{
    setRecoveredParent(null);
    if(!client || !activeSessionId || !loaded || selectedEntry)return;
    let cancelled=false;
    void client.items(activeSessionId).then(result=>{
      if(!cancelled && result.parentSessionId && result.parentSessionId!==activeSessionId)setRecoveredParent({child:activeSessionId,parent:result.parentSessionId});
    }).catch(()=>{});
    return()=>{cancelled=true;};
  },[client,activeSessionId,loaded,Boolean(selectedEntry)]);
  const parentSessionId=selectedEntry?.session.parentSessionId ?? (recoveredParent && recoveredParent.child===activeSessionId?recoveredParent.parent:null);
  const streaming = useCodexSessionStore((state) => state.streaming);
  const error = useCodexSessionStore((state) => state.error);

  const sessionListStatus: "loading" | "ready" | "error" = sessionListResolution?.client === client ? sessionListResolution.status : "loading";
  return {
    enabled,
    sessionListStatus,
    sessionListError: sessionListResolution?.client === client ? sessionListResolution.error : null,
    parentSessionId,
    sessions,
    streaming,
    error,
    config: engineConfig,
    client,
    refreshConfig: () => setConfigVersion((value) => value + 1),
    createSession: client
      ? async (input: { title?: string; prompt?: string; cwd?: string; model?: string; providerId?: string }) => {
          const result = await client.createSession(input);
          result.session.workspaceId = displayWorkspaceId ?? result.session.workspaceId;
          useCodexSessionStore.getState().upsertSession(result.session);
          return result.session;
        }
      : null,
    prompt: client
      ? async (sessionId: string, text: string, selection?: { model?: string; providerId?: string }, images?: string[]) => {
          useCodexSessionStore.setState((state) => {
            const entry = state.sessions[sessionId];
            return entry ? { sessions: { ...state.sessions, [sessionId]: { ...entry, warning: undefined } } } : state;
          });
          useCodexSessionStore.getState().startTurn(sessionId);
          try {
            const result = await client.prompt(sessionId, text, selection, images);
            // Lifecycle events are authoritative: the turn may already have
            // completed before this HTTP response arrives.
            return result.session;
          } catch (error) {
            const message = error instanceof Error ? error.message : "Sofia request failed";
            useCodexSessionStore.getState().failSession(sessionId, message);
            // The transcript error card explains the failure once; the notice
            // keeps the reason visible when the pane would otherwise look idle.
            if (isThreadWriterConflictError(error)) useCodexSessionStore.getState().setWarning(sessionId, message);
            throw error;
          }
        }
      : null,
    abort: client
      ? async (sessionId: string) => {
          await client.abort(sessionId);
        }
      : null,
    // Steer the in-flight turn (codex `turn/steer`). Returns a discriminated
    // result so the caller can start a turn or queue when steering is refused.
    steer: client
      ? (sessionId: string, text: string, images?: string[]) => client.steer(sessionId, text, images)
      : null,
    archiveSession: client
      ? async (sessionId: string, archived: boolean) => {
          const result = await client.archiveSession(sessionId, archived);
          result.session.workspaceId = displayWorkspaceId ?? result.session.workspaceId;
          useCodexSessionStore.getState().upsertSession(result.session);
        }
      : null,
    renameSession: client
      ? async (sessionId: string, title: string) => {
          const result = await client.renameSession(sessionId, title);
          result.session.workspaceId = displayWorkspaceId ?? result.session.workspaceId;
          useCodexSessionStore.getState().upsertSession(result.session);
        }
      : null,
    deleteSession: client
      ? async (sessionId: string) => {
          await client.deleteSession(sessionId);
          useCodexSessionStore.getState().removeSession(sessionId);
        }
      : null,
  };
}
