// Codex transcript adapter: bridges the codex session store into the shared
// react-query transcript cache that the existing MessageList renders. Codex
// items are translated into the engine Part/UIMessage shapes the transcript
// UI already renders (text, reasoning, tool calls, step starts), so tools and
// thinking behave the same as engine.
import type { UIMessage } from "ai";

import type { CodexSessionClient } from "@/app/lib/codex-session";
import { getReactQueryClient } from "../../../infra/query-client";
import { statusKey, transcriptKey } from "./session-sync";
import { useSessionActivityStore } from "@/react-app/domains/session/status/session-activity-store";
import { codexItemToParts, codexItemLabel, codexItemToToolPart } from "./codex-item-translator";
import { stripInjectedCodexContext } from "./codex-context-fragments";
import { useCodexSessionStore, type CodexTrackedItem } from "../codex-session-store";

/** Map a tracked codex item into UIMessage parts (mirroring engine shapes). */
function trackedItemToUIMessageParts(item: CodexTrackedItem, sessionId: string): UIMessage["parts"] {
  // Errors render through the same session-error card the engine transcript
  // uses (title + description + collapsible technical details), instead of
  // dumping the raw provider JSON into the conversation.
  if (item.errorPresentation) {
    const { title, description } = item.errorPresentation;
    return [{
      type: "text",
      text: description ? `${title}\n\n${description}` : title,
      state: "done",
      providerMetadata: { engine: { partId: `${item.id}:text`, sessionError: item.errorPresentation } },
    } as UIMessage["parts"][number]];
  }

  const parts = codexItemToParts(item.item, sessionId, item.id, "");
  const state = item.status === "pending" ? ("streaming" as const) : ("done" as const);

  // Tool/command items: emit a canonical dynamic-tool marker (bash/edit/read)
  // so engine's aggregator renders inline "Used X, edited Y" pills like codex.
  if (item.type === "commandExecution" || item.type === "mcpToolCall" || item.type === "dynamicToolCall") {
    const dynamicTool = codexItemToToolPart(item.item, sessionId, item.id, item.status === "done");
    if (!dynamicTool) return [];
    const output = item.output || (isRecord(item.item) ? item.item.aggregatedOutput as string : "") || "";
    const d = dynamicTool as Record<string, unknown>;
    if (d.state === "output-available" && !d.output) d.output = output;
    return [dynamicTool as UIMessage["parts"][number]];
  }

  // Reasoning: render as a thinking block.
  if (item.type === "reasoning") {
    const text = item.thinking || reasoningText(item.item);
    return text ? [{ type: "reasoning", text, state }] : [];
  }

  // AgentMessage / plan: normal text.
  const text = item.text || (isRecord(item.item) ? item.item.text as string : "") || "";
  if (text) return [{ type: "text", text, state }];

  // Fall back to translated parts (e.g. fileChange -> patch).
  return parts as UIMessage["parts"];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function reasoningText(item: Record<string, unknown>): string {
  const values = Array.isArray(item.summary) && item.summary.length ? item.summary : item.content;
  return Array.isArray(values) ? values.map((value) =>
    typeof value === "string" ? value : isRecord(value) && typeof value.text === "string" ? value.text : "",
  ).filter(Boolean).join("\n") : "";
}

/** Build UIMessages from a session's tracked items + user messages. */
function buildUIMessages(workspaceId: string, sessionId: string): UIMessage[] {
  const entry = useCodexSessionStore.getState().sessions[sessionId];
  if (!entry) return [];

  // Preserve engine item identity, phase and turn boundaries in both replay
  // and streaming. The view groups activity without merging or losing items.
  const assembled: UIMessage[] = [];
  for (const item of entry.items) {
    const phase = item.item.phase;
    const metadata = { engine: {
      turnId: item.turnId,
      ...(phase === "commentary" || phase === "final_answer" ? { phase } : {}),
    } };
    if (item.type === "userMessage") {
      const content = Array.isArray(item.item.content)
        ? item.item.content.map((part) => isRecord(part) && typeof part.text === "string" ? part.text : "").join("")
        : "";
      const text = stripInjectedCodexContext(item.text || content);
      if (text) assembled.push({ id: `codex-user-${item.id}`, role: "user", metadata, parts: [{ type: "text", text, state: "done" }] });
      continue;
    }
    const parts = trackedItemToUIMessageParts(item, sessionId);
    if (parts.length) assembled.push({ id: `codex-item-${item.id}`, role: "assistant", metadata, parts });
  }

  // Optimistic tail: user messages submitted locally but not yet echoed back
  // as a `userMessage` stream item render immediately so a send/steer doesn't
  // briefly vanish.
  entry.pendingUserTexts.forEach((text, index) => {
    if (!text) return;
    assembled.push({
      id: `codex-user-pending-${index}`,
      role: "user" as const,
      parts: [{ type: "text", text, state: "done" as const }],
    });
  });

  return assembled;
}

/** Push the current codex transcript for a session into the shared cache. */
export function syncCodexTranscriptToCache(workspaceId: string, sessionId: string): void {
  const queryClient = getReactQueryClient();
  const entry = useCodexSessionStore.getState().sessions[sessionId];
  if (!entry) return;
  const messages = buildUIMessages(workspaceId, sessionId);
  if (messages.length > 0) {
    queryClient.setQueryData(transcriptKey(workspaceId, sessionId), messages);
  }
  // The UI reads `statusKey` as an engine SessionStatus (`{ type: "busy" |
  // "idle" | "retry" ... }`), but the codex store keeps a bare `running`/`idle`/
  // `error` string. Write a shape the MessageList can interpret, and drive the
  // session-activity store so the send-time `busy` release happens even though
  // engine's own status sync is skipped for codex sessions (see session-sync
  // `calibrateCodexGateway`/`if (normalizedSessionId.startsWith("codex-"))`).
  const uiStatus = codexStatusToSessionStatus(entry.session.status);
  queryClient.setQueryData(statusKey(workspaceId, sessionId), uiStatus);
  // Release/assert the run-status in the activity store: busy while running,
  // idle otherwise. This is what clears the "Thinking…" spinner after the turn.
  useSessionActivityStore.getState().setRunStatus(
    workspaceId,
    sessionId,
    entry.session.status === "running" ? "busy" : "idle",
  );
}

/** Map a codex session status to the engine SessionStatus the UI reads. */
function codexStatusToSessionStatus(status: "idle" | "running" | "error"): { type: "busy" | "idle" } {
  return status === "running" ? { type: "busy" } : { type: "idle" };
}

/**
 * Subscribe to codex store changes for one session and mirror the transcript
 * into the shared cache. Returns an unsubscribe.
 */
export function mirrorCodexTranscript(workspaceId: string, sessionId: string): () => void {
  syncCodexTranscriptToCache(workspaceId, sessionId);
  return useCodexSessionStore.subscribe(() => {
    syncCodexTranscriptToCache(workspaceId, sessionId);
  });
}

/** Create a codex session with a prompt and mirror its transcript. */
export async function createCodexSessionWithTranscript(
  client: CodexSessionClient,
  workspaceId: string,
  input: { title?: string; prompt?: string; cwd?: string },
): Promise<string> {
  const result = await client.createSession(input);
  useCodexSessionStore.getState().upsertSession(result.session);
  if (result.session.id) {
    mirrorCodexTranscript(workspaceId, result.session.id);
  }
  return result.session.id;
}

/** Label helper re-exported for tests. */
export function codexItemTitle(item: Record<string, unknown>): string {
  return codexItemLabel(item);
}

/**
 * Restore a session's persisted items into the store (for transcripts on open).
 * Mirrors what the live stream builds, using item objects from thread/itemsList.
 */
export async function restoreCodexSessionItems(
  client: CodexSessionClient,
  workspaceId: string,
  sessionId: string,
): Promise<void> {
  try {
    const result = await client.items(sessionId);
    const store = useCodexSessionStore.getState();
    for (const entry of result.items) {
      const item = entry.item;
      if (!isRecord(item) || !item.type) continue;
      const itemId = typeof item.id === "string" ? item.id : `${item.type}-${entry.turnId}`;
      store.upsertItem(sessionId, {
        id: itemId,
        type: String(item.type),
        turnId: entry.turnId || itemId,
        item,
        text: typeof item.text === "string" ? item.text : "",
        thinking: item.type === "reasoning" ? reasoningText(item) : "",
        output: typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : "",
        status: "done",
      });
    }
    syncCodexTranscriptToCache(workspaceId, sessionId);
    useCodexSessionStore.getState().setWarning(sessionId, undefined);
  } catch (error) {
    // Best-effort restore must not fail silently: an explainable notice beats a
    // blank pane when the transcript cannot be read (engine down, task held by
    // another Sofia process, …).
    useCodexSessionStore.getState().setWarning(sessionId, error instanceof Error ? error.message : String(error));
  }
}

/**
 * Make sure a session's transcript is in the shared cache when it is opened.
 *
 * The boot-time restore writes every codex transcript with `setQueryData`, but
 * those entries have no observer, so TanStack GC drops them once the
 * transcript/status `gcTime` elapses (see `getReactQueryClient`). Opening the
 * task afterwards rendered a blank pane and nothing refetched it — the snapshot
 * query is disabled for codex sessions. Mirror the store when it already has
 * the items (cheap) and read them back from the engine otherwise (which also
 * raises a notice when the read fails, e.g. the thread is held elsewhere).
 */
export async function ensureCodexTranscriptCached(
  client: CodexSessionClient,
  workspaceId: string,
  sessionId: string,
): Promise<void> {
  const entry = useCodexSessionStore.getState().sessions[sessionId];
  if (entry && entry.items.length > 0) {
    syncCodexTranscriptToCache(workspaceId, sessionId);
    return;
  }
  await restoreCodexSessionItems(client, workspaceId, sessionId);
}
