/** @jsxImportSource react */
import { useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { createCodexSessionClient, type CodexEngineConfigWire } from "@/app/lib/codex-session";
import { setCodexAbortHandler } from "@/app/lib/opencode-session";
import { useSelectedEngine } from "./engine-selection-store";
import { runCodexStream, useCodexSessionStore } from "./codex-session-store";
import { syncCodexTranscriptToCache, restoreCodexSessionItems } from "./sync/codex-transcript-adapter";

export type CodexEngineEndpoint = {
  baseUrl: string;
  token: string;
  hostToken?: string;
  workspaceId: string;
  displayWorkspaceId?: string;
};

/**
 * Wires the codex session store to a workspace's codex engine when the selected
 * engine is codex: loads existing sessions and opens the SSE stream. When the
 * engine is opencode, the codex store is cleared so the opencode session
 * surface takes over.
 */
export function useCodexEngine(endpoint: CodexEngineEndpoint | null) {
  const engine = useSelectedEngine();
  const enabled = engine === "codex" && Boolean(endpoint);
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

  const [engineConfig, setEngineConfig] = useState<CodexEngineConfigWire | null>(null);
  const [configVersion, setConfigVersion] = useState(0);
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

  useEffect(() => {
    const store = useCodexSessionStore.getState();
    if (!enabled || !client) {
      store.clear();
      store.setStreaming(false);
      return;
    }
    const controller = new AbortController();
    // Mirror every codex session's transcript into the shared react-query
    // cache (transcriptKey/statusKey) so the existing MessageList renders
    // codex sessions with no surface-specific code. Coalesce to one cache
    // write per animation frame — long streams otherwise rebuild the whole
    // transcript per delta and starve the main thread (the same freeze the
    // opencode sync guards against).
    let mirrorFrame: number | null = null;
    const mirror = () => {
      if (mirrorFrame !== null) return;
      mirrorFrame = requestAnimationFrame(() => {
        mirrorFrame = null;
        for (const entry of Object.values(useCodexSessionStore.getState().sessions)) {
          syncCodexTranscriptToCache(entry.session.workspaceId, entry.session.id);
        }
      });
    };
    const unsubscribe = useCodexSessionStore.subscribe(mirror);
    void (async () => {
      try {
        const list = (await client.listSessions()).map((session) => ({ ...session, workspaceId: displayWorkspaceId ?? session.workspaceId }));
        if (controller.signal.aborted) return;
        store.replaceSessions(list);
        // Restore persisted items so existing sessions show their transcript
        // (tools, reasoning) on open — not just live streams.
        await Promise.all(
          list.map((session) => restoreCodexSessionItems(client, session.workspaceId, session.id)),
        );
      } catch {
        store.setError("Failed to load codex sessions");
      }
      if (!controller.signal.aborted) await runCodexStream(client, controller.signal, undefined, displayWorkspaceId);
    })();
    return () => {
      controller.abort();
      if (mirrorFrame !== null) cancelAnimationFrame(mirrorFrame);
      unsubscribe();
    };
  }, [enabled, client, displayWorkspaceId]);

  // All store hooks must run at the top with stable selectors; a selector that
  // builds a new array each call makes useSyncExternalStore loop forever.
  const workspaceId = displayWorkspaceId;
  const sessions = useCodexSessionStore(
    useShallow((state) =>
      Object.values(state.sessions)
        .filter((entry) => entry.session.workspaceId === workspaceId && !entry.session.archived)
        .map((entry) => entry.session),
    ),
  );
  const streaming = useCodexSessionStore((state) => state.streaming);
  const error = useCodexSessionStore((state) => state.error);

  return {
    enabled,
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
      ? async (sessionId: string, text: string, selection?: { model?: string; providerId?: string }) => {
          useCodexSessionStore.getState().startTurn(sessionId);
          try {
            const result = await client.prompt(sessionId, text, selection);
            // Lifecycle events are authoritative: the turn may already have
            // completed before this HTTP response arrives.
            return result.session;
          } catch (error) {
            useCodexSessionStore.getState().failSession(sessionId, error instanceof Error ? error.message : "Sofia request failed");
            throw error;
          }
        }
      : null,
    abort: client
      ? async (sessionId: string) => {
          await client.abort(sessionId);
        }
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
