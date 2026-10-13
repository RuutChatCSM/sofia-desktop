import { mergeCanonicalItemOrder } from "./canonical-item-order";
import { normalizeUserMessageDisplayParts } from "./user-message-display";
import { restoreRecordedTurnChanges } from "../changes/change-set-store";
// Codex transcript adapter: bridges the codex session store into the shared
// react-query transcript cache that the existing MessageList renders. Codex
// items are translated into the engine Part/UIMessage shapes the transcript
// UI already renders (text, reasoning, tool calls, step starts), so tools and
// thinking behave the same as engine.
import type { UIMessage } from "ai";

import type { CodexSessionClient } from "@/app/lib/codex-session";
import { getReactQueryClient } from "../../../infra/query-client";
import { statusKey, todoKey, transcriptKey } from "./session-sync";
import type { TodoItem } from "@/app/types";
import { useSessionActivityStore } from "@/react-app/domains/session/status/session-activity-store";
import { codexItemToParts, codexItemLabel, codexItemToToolPart, codexItemToToolParts } from "./codex-item-translator";
import { stripInjectedCodexContext } from "./codex-context-fragments";
import { useCodexSessionStore, type CodexTrackedItem } from "../codex-session-store";
import { sentAttachments } from "./sent-attachment-store";

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

  if (item.type === "networkStatus" || item.type === "contextCompaction" || item.type === "fileChange" || (item.type === "commandExecution" && Array.isArray(item.item.commandActions) && item.item.commandActions.length>1) || (item.type === "dynamicToolCall" && (item.item.tool==="apply_patch" || (isRecord(item.item.arguments) && Array.isArray(item.item.arguments.nestedCalls)))))return codexItemToToolParts(item.item,sessionId,item.id,item.status==="done");

  // Tool/command items: emit a canonical dynamic-tool marker (bash/edit/read)
  // so engine's aggregator renders inline "Used X, edited Y" pills like codex.
  if (item.type === "commandExecution" || item.type === "mcpToolCall" || item.type === "dynamicToolCall" || item.type === "webSearch" || item.type === "collabAgentToolCall" || item.type === "subAgentActivity") {
    const dynamicTool = codexItemToToolPart(item.item, sessionId, item.id, item.status === "done");
    if (!dynamicTool) return [];
    const output = item.output || (isRecord(item.item) ? item.item.aggregatedOutput as string : "") || "";
    const d = dynamicTool as Record<string, unknown>;
    if (item.turnOutcome === "cancelled" && item.item.status === "inProgress") {
      d.state = "output-error";
      d.errorText = "Interrupted";
    }
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

/**
 * The UIMessage already built for a tracked item, keyed by that item's object
 * identity. The store replaces only the entry it touched (`appendItemText` and
 * friends keep every other item's reference), so identity is an exact "did this
 * item change" test.
 *
 * Without this, each frame rebuilt every message in the session, giving every
 * row a fresh object — React.memo could not skip any of them, so a long
 * conversation re-rendered end to end ~60x/second while an answer streamed and
 * the window stopped responding. Now only the streaming item is rebuilt.
 */
const messageByTrackedItem = new WeakMap<object, UIMessage>();

/** Build UIMessages from a session's tracked items + user messages. */
function buildUIMessages(workspaceId: string, sessionId: string): UIMessage[] {
  const entry = useCodexSessionStore.getState().sessions[sessionId];
  if (!entry) return [];

  // Preserve engine item identity, phase and turn boundaries in both replay
  // and streaming. The view groups activity without merging or losing items.
  const assembled: UIMessage[] = [];
  // The engine echoes a user turn as text only, so the attachment parts are
  // taken from what this client actually sent — matched to the echoed text in
  // submission order — and merged back below. Without this an image the user
  // attached never appears in the transcript.
  const unsentAttachments = [...entry.sentUserMessages];
  const userMessageCount = entry.items.filter((item) => item.type === "userMessage").length;
  const takeSentParts = (text: string, ordinal: number) => {
    if (!unsentAttachments.length) return null;
    const target = text.trim();
    const byOrdinal = unsentAttachments.findIndex((message) => message.userMessageOrdinal === ordinal);
    if (byOrdinal >= 0) return unsentAttachments.splice(byOrdinal, 1)[0] ?? null;
    const matched = unsentAttachments.findIndex((message) => message.userMessageOrdinal === undefined && (message.matchText ?? message.text) === target);
    if (matched >= 0) return unsentAttachments.splice(matched, 1)[0] ?? null;
    // Text is a hint, not a requirement. A turn can echo text that differs from
    // what we recorded (the composer's `[attachment …]` placeholder is stripped
    // before sending, injected context is stripped after), and an image-only turn
    // echoes nothing at all. Either way the attachments belong to the next
    // unconsumed record in submission order — matching strictly on text blanked
    // the image the moment the echo landed.
    if (ordinal < userMessageCount - entry.sentUserMessages.length) return null;
    const legacyIndex = unsentAttachments.findIndex((message) => message.userMessageOrdinal === undefined);
    return legacyIndex >= 0 ? unsentAttachments.splice(legacyIndex, 1)[0] ?? null : null;
  };
  // Durable copy. After a reload the in-memory queue above is empty, and this is
  // the only reason a previously sent image still renders. It is read-only: the
  // match has to survive the next rebuild too, so a cursor walks the list once.
  const persistedAttachments = sentAttachments(sessionId);
  const consumedPersisted = new Set<number>();
  const takePersistedParts = (text: string, ordinal: number) => {
    const target = text.trim();
    const byOrdinal = persistedAttachments.findIndex((record, index) => !consumedPersisted.has(index) && record.userMessageOrdinal === ordinal);
    if (byOrdinal >= 0) {
      consumedPersisted.add(byOrdinal);
      return persistedAttachments[byOrdinal];
    }
    const matched = persistedAttachments.findIndex((record, index) => !consumedPersisted.has(index) && record.userMessageOrdinal === undefined && record.text === target);
    if (matched >= 0) {
      consumedPersisted.add(matched);
      return persistedAttachments[matched];
    }
    // Same reasoning as above: fall back to the oldest unconsumed record rather
    // than dropping the image because the text drifted.
    if (ordinal < userMessageCount - persistedAttachments.length) return null;
    const fallbackIndex = persistedAttachments.findIndex((record, index) => !consumedPersisted.has(index) && record.userMessageOrdinal === undefined);
    if (fallbackIndex < 0) return null;
    consumedPersisted.add(fallbackIndex);
    return persistedAttachments[fallbackIndex];
  };
  let userMessageOrdinal = 0;
  for (const item of entry.items) {
    const phase = item.item.phase;
    const metadata = {
      engine: {
        turnId: item.turnId,
        ...(item.turnStartedAt === undefined ? {} : { turnStartedAt: item.turnStartedAt }),
        ...(item.turnCompletedAt === undefined ? {} : { turnCompletedAt: item.turnCompletedAt }),
        ...(item.turnOutcome ? { turnOutcome: item.turnOutcome } : {}),
        ...(phase === "commentary" || phase === "final_answer" ? { phase } : {}),
      },
      // Locally observed clock. Codex items carry no `created`/`completed`, so
      // this is what lets a turn be timed at all (see getMessageCreated).
      local: {
        ...(typeof item.createdAt === "number" && (!item.historical || typeof item.item.createdAt === "number") ? { createdAt: item.createdAt } : {}),
        ...(typeof item.completedAt === "number" && (!item.historical || typeof item.item.completedAt === "number") ? { completedAt: item.completedAt } : {}),
      },
    };
    if (item.type === "userMessage") {
      const ordinal = userMessageOrdinal++;
      const content = Array.isArray(item.item.content)
        ? item.item.content.map((part) => isRecord(part) && typeof part.text === "string" ? part.text : "").join("")
        : "";
      const text = stripInjectedCodexContext(item.text || content);
      const sent = takeSentParts(text, ordinal);
      const persisted = takePersistedParts(text, ordinal);
      const ordered = sent?.orderedParts ? sent : persisted?.orderedParts ? persisted : null;
      const importedImages: UIMessage["parts"] = Array.isArray(item.item.content) ? item.item.content.flatMap(part =>
        isRecord(part) && part.type === "image" && typeof part.url === "string" ? [{ type: "file" as const, mediaType: "image/png", url: part.url }] : []) : [];
      const attachmentParts = sent?.parts.length ? sent.parts : persisted?.parts.length ? persisted.parts : importedImages;
      const hasAnnotation = attachmentParts.some((part) => part.type === "file" && part.mediaType === "application/x-sofia-annotation");
      const visibleText = hasAnnotation ? sent?.text ?? persisted?.displayText ?? text : text;
      // An image-only turn echoes no text at all: the attachments are the whole
      // message, so render it even when the text is empty.
      if (visibleText || attachmentParts.length) {
        const parts: UIMessage["parts"] = ordered?.parts ?? [
          ...(visibleText ? [{ type: "text" as const, text: visibleText, state: "done" as const }] : []),
          ...attachmentParts,
        ];
        assembled.push({
          id: `codex-user-${item.id}`,
          role: "user",
          metadata,
          parts:normalizeUserMessageDisplayParts(parts),
        });
      }
      continue;
    }
    const cached = messageByTrackedItem.get(item);
    if (cached) {
      assembled.push(cached);
      continue;
    }
    const parts = trackedItemToUIMessageParts(item, sessionId);
    if (parts.length) {
      const message: UIMessage = { id: `codex-item-${item.id}`, role: "assistant", metadata, parts };
      messageByTrackedItem.set(item, message);
      assembled.push(message);
    }
  }

  // Keep an unacknowledged submission where it was sent. Later assistant
  // activity must not drag it to the bottom while its SSE echo is delayed.
  let previousPendingIndex = -1;
  [...(entry.settledUserMessages ?? []), ...entry.pendingUserMessages].forEach((message, index) => {
    if (!message.text && !message.parts.length) return;
    const anchor = entry.items.findIndex(item => item.id === message.afterItemId);
    let insertion = 0;
    for (let itemIndex = anchor; itemIndex >= 0; itemIndex--) {
      const id = entry.items[itemIndex].id;
      const renderedIndex = assembled.findIndex(item => item.id === `codex-item-${id}` || item.id === `codex-user-${id}`);
      if (renderedIndex >= 0) { insertion = renderedIndex + 1; break; }
    }
    insertion = Math.max(insertion, previousPendingIndex + 1);
    assembled.splice(insertion, 0, {
      id: `codex-user-pending-${index}`,
      role: "user",
      parts: message.orderedParts ? message.parts : [...(message.text ? [{ type: "text" as const, text: message.text, state: "done" as const }] : []), ...message.parts],
    });
    previousPendingIndex = insertion;
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
  // Codex's `update_plan` checklist is not an item, so it has no transcript
  // representation. Mirror it into the same todo cache the engine's `todowrite`
  // tool feeds (keyed by workspace + session), which drives the task checklist
  // panel. Only write once a plan exists so an engine session's null state is
  // never clobbered.
  if (entry.plan) {
    const todos: TodoItem[] = entry.plan.map((item, index) => ({
      id: `plan-${index}`,
      content: item.step,
      status: item.status,
      priority: "medium",
    }));
    queryClient.setQueryData(todoKey(workspaceId, sessionId), todos);
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
  client: Pick<CodexSessionClient, "items">,
  workspaceId: string,
  sessionId: string,
  signal?: AbortSignal,
): Promise<void> {
  const initial = useCodexSessionStore.getState().sessions[sessionId];
  if (!initial) return;
  useCodexSessionStore.getState().invalidateCanonical(sessionId);
  const epoch = useCodexSessionStore.getState().sessions[sessionId]?.canonicalEpoch;
  try {
    const result = await client.items(sessionId);
    if (signal?.aborted || useCodexSessionStore.getState().sessions[sessionId]?.canonicalEpoch !== epoch) return;
    if (!result.ok) throw new Error("Could not refresh the saved conversation");
    if(result.subagentSessions)useCodexSessionStore.setState(state=>{
      const entry=state.sessions[sessionId];
      return entry?{sessions:{...state.sessions,[sessionId]:{...entry,subagentSessions:result.subagentSessions}}}:state;
    });
    for (const record of result.changes ?? []) restoreRecordedTurnChanges(record);
    const store = useCodexSessionStore.getState();
    // The durable `update_plan` checklist rides along with the restored items,
    // so a reopened task shows its progress before any new plan update arrives.
    if (result.plan) store.setPlan(sessionId, result.plan);
    const authoritativeIds = new Set(result.items.map(entry => typeof entry.item.id === "string" ? entry.item.id : `${entry.item.type}-${entry.turnId}`));
    // The server preserves a rollout item's old ID when materialization supplies
    // the canonical engine ID. Retire only that explicitly identified alias;
    // equal text alone is not evidence that two submissions are duplicates.
    const aliases = new Map(result.items.flatMap(({ item }) =>
      typeof item.recordedItemId === "string" && typeof item.id === "string" && item.recordedItemId !== item.id
        ? [[item.recordedItemId, item.id] as const] : []));
    if (aliases.size) useCodexSessionStore.setState(state => {
      const current = state.sessions[sessionId];
      if (!current) return state;
      const removedUsers = current.items.map((item, index) => ({ item, index })).filter(({ item }) => item.type === "userMessage" && aliases.has(item.id));
      const reconcileSubmission = (message: import("../codex-session-store").CodexUserMessageRecord) => {
        const anchor = current.items.findIndex(item => item.id === message.afterItemId);
        const removedBeforeSubmission = removedUsers.filter(({ index }) => index <= anchor).length;
        return {
          ...message,
          ...(message.afterItemId && aliases.has(message.afterItemId) ? { afterItemId: aliases.get(message.afterItemId) } : {}),
          ...(message.userMessageOrdinal === undefined ? {} : { userMessageOrdinal: Math.max(0, message.userMessageOrdinal - removedBeforeSubmission) }),
        };
      };
      return { sessions: { ...state.sessions, [sessionId]: {
        ...current,
        items: current.items.filter(item => !aliases.has(item.id)),
        pendingUserMessages: current.pendingUserMessages.map(reconcileSubmission),
        settledUserMessages: current.settledUserMessages?.map(reconcileSubmission),
        sentUserMessages: current.sentUserMessages.map(reconcileSubmission),
      } } };
    });

    // An item read can be a bounded or lagging snapshot, including after an
    // interrupted turn. Absence is not deletion evidence: keep previously
    // observed history and live progress until explicit rollback/removal.

    for (const entry of result.items) {
      const item = entry.item;
      if (!isRecord(item) || !item.type) continue;
      const itemId = typeof item.id === "string" ? item.id : `${item.type}-${entry.turnId}`;
      const session = store.sessions[sessionId]?.session;
      const activeUnsettled = (item.type === "agentMessage" || item.type === "reasoning") &&
        item.status === undefined && session?.status === "running" && session.turnId === entry.turnId;
      store.upsertItem(sessionId, {
        id: itemId,
        type: String(item.type),
        historical: true,
        ...(typeof item.turnStartedAt === "number" ? { turnStartedAt: item.turnStartedAt } : {}),
        ...(typeof item.turnCompletedAt === "number" ? { turnCompletedAt: item.turnCompletedAt } : {}),
        turnId: entry.turnId || itemId,
        item,
        ...(typeof item.createdAt === "number" ? { createdAt: item.createdAt } : {}),
        ...(typeof item.completedAt === "number" ? { completedAt: item.completedAt } : {}),
        text: typeof item.text === "string" ? item.text : "",
        thinking: item.type === "reasoning" ? reasoningText(item) : "",
        output: typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : "",
        status: item.status === "inProgress" || activeUnsettled ? "pending" : item.status === "failed" || item.status === "declined" ? "error" : "done",
      });
    }
    // Recovery is also an acknowledgement path: an SSE echo may have been
    // missed while disconnected. Match by ordinal so a repeated historical
    // prompt cannot acknowledge a newer submission with the same text.
    let userOrdinal = 0;
    for (const entry of result.items) {
      if (entry.item.type !== "userMessage") continue;
      const content = Array.isArray(entry.item.content) ? entry.item.content.map(part => isRecord(part) && typeof part.text === "string" ? part.text : "").join("") : "";
      store.confirmPendingUserMessage(sessionId, typeof entry.item.text === "string" ? entry.item.text : content, userOrdinal++);
    }
    const outcomes = new Map((result.outcomes ?? []).map(outcome => [outcome.turnId, outcome]));
    for (const tracked of useCodexSessionStore.getState().sessions[sessionId]?.items ?? []) {
      const outcome = outcomes.get(tracked.turnId);
      // A live terminal event already recorded in this renderer wins.
      if (!outcome) continue;
      const interruptedTool = outcome.outcome === "cancelled" && tracked.item.status === "inProgress";
      store.upsertItem(sessionId, {
        ...tracked,
        turnOutcome: tracked.turnOutcome ?? outcome.outcome,
        ...(outcome.startedAt === undefined ? {} : { turnStartedAt: outcome.startedAt }),
        ...(outcome.completedAt === undefined ? {} : { turnCompletedAt: outcome.completedAt }),
        status: interruptedTool ? "error" : tracked.status === "pending" ? "done" : tracked.status,
        ...(outcome.completedAt === undefined || tracked.completedAt !== undefined ? {} : { completedAt: outcome.completedAt }),
      });
    }
    // Upserts preserve existing array positions. A formerly partial replay can
    // therefore put newly recovered commentary after old tools unless we restore
    // the authoritative order as well as the content.
    useCodexSessionStore.setState(state=>{
      const current=state.sessions[sessionId];
      if(!current)return state;
      const byId=new Map(current.items.map(item=>[item.id,item]));
      const ordered=result.items.flatMap(entry=>{
        const id=typeof entry.item.id==="string"?entry.item.id:`${entry.item.type}-${entry.turnId}`;
        const item=byId.get(id);return item?[item]:[];
      });
      return {sessions:{...state.sessions,[sessionId]:{...current,items:mergeCanonicalItemOrder(current.items, ordered)}}};
    });
    useCodexSessionStore.setState(state => {
      const current = state.sessions[sessionId];
      return current && current.canonicalEpoch === epoch ? { sessions: { ...state.sessions, [sessionId]: { ...current, canonicalReady: true } } } : state;
    });
    syncCodexTranscriptToCache(workspaceId, sessionId);
    useCodexSessionStore.getState().setWarning(sessionId, undefined);
  } catch (error) {
    if (signal?.aborted || useCodexSessionStore.getState().sessions[sessionId]?.canonicalEpoch !== epoch) return;
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
    // Opening a live task must render its known narrative immediately. A
    // pending durable read is reconciliation, not a reason to show a blank pane.
    syncCodexTranscriptToCache(workspaceId, sessionId);
    if (entry.canonicalReady) return;
  }
  await restoreCodexSessionItems(client, workspaceId, sessionId);
}

/** Recover durable history after an event-stream gap without clearing visible items. */
export async function recoverCodexSessions(
  client: Pick<CodexSessionClient, "listSessions" | "items">,
  signal: AbortSignal,
  workspaceId?: string,
): Promise<void> {
  const before = useCodexSessionStore.getState().sessions;
  const sessions = await client.listSessions();
  if (signal.aborted) return;
  for (const session of sessions) {
    const current = useCodexSessionStore.getState().sessions[session.id];
    const previous = before[session.id]?.session;
    const liveChanged = current && (current.session.status !== previous?.status || current.session.turnId !== previous?.turnId);
    const restored = { ...session, workspaceId: workspaceId ?? session.workspaceId,
      ...(liveChanged ? { status: current.session.status, turnId: current.session.turnId } : {}) };
    useCodexSessionStore.getState().upsertSession(restored);
    await restoreCodexSessionItems(client, restored.workspaceId, restored.id, signal);
    if (signal.aborted) return;
  }
}
