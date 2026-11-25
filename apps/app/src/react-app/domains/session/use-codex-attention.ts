/** @jsxImportSource react */
import { useEffect, useMemo, useRef } from "react";

import {
  createCodexAttentionClient,
  type CodexAttentionClient,
  type CodexEvent,
  type CodexSession,
} from "@/app/lib/codex-session";
import { notifyAlert } from "@/react-app/shell/notifications";
import { backgroundProcessFailureTitle, useCodexSessionStore } from "./codex-session-store";
import { useSessionManagementStore } from "./sidebar/session-management-store";

export type CodexAttentionEndpoint = {
  baseUrl: string;
  token: string;
  hostToken?: string;
};

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 5_000;

/**
 * Cross-workspace attention feed. `apps/server` observes every workspace it
 * manages, so this stays live no matter which workspace the window shows — a
 * background failure in another workspace still marks that session and raises
 * one notification that opens it. Events are acknowledged so the server stops
 * replaying pending ones.
 */
export function useCodexAttentionFeed(endpoint: CodexAttentionEndpoint | null, streamedWorkspaceId?: string | null): void {
  // The streamed workspace already gets ordered status on its own stream; this
  // feed only fills in the others, so it can never apply an older state.
  const streamedWorkspace = useRef(streamedWorkspaceId);
  streamedWorkspace.current = streamedWorkspaceId;
  const endpointKey = endpoint
    ? `${endpoint.baseUrl}\u001f${endpoint.token}\u001f${endpoint.hostToken ?? ""}`
    : "";
  const client = useMemo(
    () =>
      endpoint
        ? createCodexAttentionClient({
            baseUrl: endpoint.baseUrl,
            token: endpoint.token,
            hostToken: endpoint.hostToken,
          })
        : null,
    // Recreate only when the endpoint identity changes, not on every render.
    [endpointKey],
  );
  const seen = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!client) return;
    const controller = new AbortController();
    void runAttentionFeed(client, controller.signal, seen.current, () => streamedWorkspace.current);
    return () => controller.abort();
  }, [client]);
}

async function runAttentionFeed(
  client: CodexAttentionClient,
  signal: AbortSignal,
  seen: Set<string>,
  streamedWorkspaceId: () => string | null | undefined,
): Promise<void> {
  for (let attempt = 1; !signal.aborted; attempt++) {
    try {
      await client.stream(signal, (event) => {
        if (event.type === "session.updated") applyBackgroundStatus(event.session, streamedWorkspaceId());
        else handleAttentionEvent(event, client, seen);
      });
      if (!signal.aborted) throw new Error("attention feed closed");
    } catch {
      if (signal.aborted) break;
    }
    await delay(Math.min(RECONNECT_BASE_MS * attempt, RECONNECT_MAX_MS), signal);
  }
}

/** Keep a background workspace's sidebar row (running, idle, title) live. */
function applyBackgroundStatus(session: CodexSession, streamedWorkspaceId: string | null | undefined): void {
  const existing = useCodexSessionStore.getState().sessions[session.id];
  if (!existing || existing.session.workspaceId === streamedWorkspaceId) return;
  useCodexSessionStore.getState().upsertSession({ ...session, workspaceId: existing.session.workspaceId });
}

function handleAttentionEvent(
  event: CodexEvent,
  client: CodexAttentionClient,
  seen: Set<string>,
): void {
  if (event.type !== "backgroundProcess.failed") return;
  const key = `${event.sessionId}:${event.itemId}:failed`;
  if (seen.has(key)) return;
  seen.add(key);
  useSessionManagementStore.getState().markNeedsAttention(event.sessionId);
  notifyAlert({
    kind: "system",
    severity: "error",
    title: backgroundProcessFailureTitle({
      itemId: event.itemId,
      processId: event.processId,
      command: event.command,
      status: "failed",
      ...(typeof event.exitCode === "number" ? { exitCode: event.exitCode } : {}),
    }),
    body: event.sessionTitle || undefined,
    dedupeKey: key,
    action: {
      type: "open-session",
      workspaceId: event.workspaceId,
      sessionId: event.sessionId,
    },
    actionLabel: "Open session",
  });
  void client.ack({ sessionId: event.sessionId, itemId: event.itemId }).catch(() => undefined);
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}
