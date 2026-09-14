// Codex transcript adapter: bridges the codex session store into the shared
// react-query transcript cache that the existing MessageList renders. Codex
// items are translated into the opencode Part/UIMessage shapes the transcript
// UI already renders (text, reasoning, tool calls, step starts), so tools and
// thinking behave the same as opencode.
import type { UIMessage } from "ai";

import type { CodexSessionClient } from "@/app/lib/codex-session";
import { getReactQueryClient } from "../../../infra/query-client";
import { statusKey, transcriptKey } from "./session-sync";
import { useSessionActivityStore } from "@/react-app/domains/session/status/session-activity-store";
import { codexItemToParts, codexItemLabel, codexItemToToolPart } from "./codex-item-translator";
import { useCodexSessionStore, type CodexTrackedItem } from "../codex-session-store";

/** Map a tracked codex item into UIMessage parts (mirroring opencode shapes). */
function trackedItemToUIMessageParts(item: CodexTrackedItem, sessionId: string): UIMessage["parts"] {
  const parts = codexItemToParts(item.item, sessionId, item.id, "");
  const state = item.status === "pending" ? ("streaming" as const) : ("done" as const);

  // Tool/command items: emit a canonical dynamic-tool marker (bash/edit/read)
  // so opencode's aggregator renders inline "Used X, edited Y" pills like codex.
  if (item.type === "commandExecution" || item.type === "mcpToolCall" || item.type === "dynamicToolCall") {
    const dynamicTool = codexItemToToolPart(item.item, sessionId, item.id);
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

  // Build the transcript purely from the ordered `items` list. Item.started /
  // textDelta / completed arrive in conversation order (reasoning → tools →
  // agentMessage), and deltas stream into the owning item, so this single pass
  // preserves order and never duplicates (the old code also seeded from the
  // `messages` array, which re-created assistant replies and reordered the
  // reasoning after the answer). Each user exchange is its own turn; items of
  // one turn coalesce into a single assistant message.
  const assembled: UIMessage[] = [];
  let currentAssistant: UIMessage | null = null;

  const flushAssistant = () => {
    if (currentAssistant) {
      assembled.push(currentAssistant);
      currentAssistant = null;
    }
  };

  for (const item of entry.items) {
    if (item.type === "userMessage") {
      flushAssistant();
      const content = isRecord(item.item) && Array.isArray(item.item.content)
        ? (item.item.content as unknown[]).map((c) => isRecord(c) ? typeof c.text === "string" ? c.text : "" : "").join("")
        : "";
      const text = item.text || content || "";
      if (text) {
        assembled.push({ id: `codex-user-${item.id}`, role: "user" as const, parts: [{ type: "text", text, state: "done" as const }] });
      }
      continue;
    }
    const parts = trackedItemToUIMessageParts(item, sessionId);
    if (parts.length === 0) continue;
    if (!currentAssistant) {
      currentAssistant = { id: `codex-item-${item.id}`, role: "assistant" as const, parts: [] };
    }
    currentAssistant.parts.push(...parts);
  }
  flushAssistant();

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
  // The UI reads `statusKey` as an opencode SessionStatus (`{ type: "busy" |
  // "idle" | "retry" ... }`), but the codex store keeps a bare `running`/`idle`/
  // `error` string. Write a shape the MessageList can interpret, and drive the
  // session-activity store so the send-time `busy` release happens even though
  // opencode's own status sync is skipped for codex sessions (see session-sync
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

/** Map a codex session status to the opencode SessionStatus the UI reads. */
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
  } catch {
    // Best-effort restore.
  }
}
