import { restoreRecordedTurnChanges } from "./changes/change-set-store";
// Sofia session store: holds codex engine sessions and their transcripts as
// accumulated from the SSE stream. Mirrors the engine session surface enough
// to drive the existing transcript UI: each session accumulates a text body
// from `message.delta`, and status from `item.*` / `turn.completed`.
import { create } from "zustand";
import { useSessionActivityStore } from "./status/session-activity-store";
import type { UIMessage } from "ai";

import type { BackgroundProcess, CodexEvent, CodexPlanItem, CodexSession, CodexSessionClient, CodexSessionStatus } from "@/app/lib/codex-session";
import type { WorkspaceEngineSessionErrorPresentation } from "./sync/session-error";
import {
  baselineFromChanges,
  changeSetFromRepository,
  type TurnBaseline,
} from "./changes/change-set-source";
import type { FileChange } from "./changes/turn-change-set";
import { useChangeSetStore } from "./changes/change-set-store";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Extract plain text from a codex `userMessage` item payload. */
function userMessageText(item: Record<string, unknown>): string {
  if (typeof item.text === "string" && item.text.trim()) return item.text;
  if (Array.isArray(item.content)) {
    return item.content
      .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
      .join("");
  }
  return "";
}

export type SofiaErrorDetails = {
  title: string;
  body: string;
  provider: string | null;
  variable: string | null;
  raw: string;
};

/**
 * Turn a raw engine/provider error into conversation-level prose instead of
 * dumping JSON into the chat. The structured `{"error":{"message":...}}` body,
 * `Sofia RPC error (…):` prefix, and known failure shapes (missing credentials)
 * are unwrapped so the primary content reads like a sentence, not a payload.
 */
export function describeSofiaError(message: string): SofiaErrorDetails {
  const raw = message;
  // Unwrap the JSON error body if one is embedded anywhere in the message.
  let detail = message.replace(/^(?:sofia|codex) rpc error \([^)]*\):\s*/i, "").trim();
  const jsonStart = detail.indexOf("{");
  if (jsonStart >= 0) {
    try {
      const parsed: unknown = JSON.parse(detail.slice(jsonStart));
      const err = isRecord(parsed) && isRecord(parsed.error) ? parsed.error : null;
      if (err && typeof err.message === "string" && err.message.trim()) {
        detail = err.message.trim();
      }
    } catch {
      // Not JSON — keep the text as-is.
    }
  }

  const missingVar = /missing environment variable:?\s*`?([A-Z0-9_]+)`?/i.exec(detail)?.[1]
    ?? /environment variable:?\s*`?([A-Z0-9_]+)`?/i.exec(detail)?.[1];
  if (missingVar) {
    const provider = missingVar.replace(/_API_KEY$/, "");
    const name = provider.charAt(0).toUpperCase() + provider.slice(1).toLowerCase();
    return {
      title: `${name} credentials unavailable`,
      body: `Missing environment variable: ${missingVar}\n\nSofia couldn't continue using ${name}.`,
      provider: name,
      variable: missingVar,
      raw,
    };
  }

  const unauthorized = /401|unauthorized|missing bearer/i.test(detail);
  if (unauthorized) {
    return {
      title: "Provider authentication failed",
      body: "The provider rejected Sofia's credentials. Reconnect the provider or check its API key.",
      provider: null,
      variable: null,
      raw,
    };
  }

  return { title: "Sofia hit an error", body: detail, provider: null, variable: null, raw };
}


export type CodexTranscriptMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  thinking: string;
  status: "pending" | "done" | "error";
};

/** A codex ThreadItem as tracked by the store: its type, engine-translated
 * parts, and live accumulator buffers for deltas. */
export type CodexTrackedItem = {
  id: string;
  type: string;
  turnId: string;      // groups items of one user exchange into a single turn
  /**
   * UI-recorded clock for this item. Engine items carry no `created`/`completed`
   * on the codex wire, so without these a turn had to be timed from a session
   * clock that reset on every new item — a long turn reported as "Worked for 2s".
   */
  historical?: boolean;
  turnStartedAt?: number;
  turnCompletedAt?: number;
  createdAt?: number;
  completedAt?: number;
  turnOutcome?: "completed" | "cancelled" | "failed";
  item: Record<string, unknown>;
  text: string;        // accumulated agentMessage/command output
  thinking: string;    // accumulated reasoning
  output: string;      // accumulated command output
  status: "pending" | "done" | "error";
  /** Structured error for the transcript to render as a card (reuses the
   * engine session-error presentation). */
  errorPresentation?: WorkspaceEngineSessionErrorPresentation;
};

/** A user turn as this client sent it: the text plus the attachment parts the
 * transcript renders. */
export type CodexUserMessageRecord = {
  /** Last engine item visible when this submission was accepted locally. */
  afterItemId?: string;
  text: string;
  /** The text the engine will echo, when it differs from what the user saw: the
   * composer's `[attachment …]` placeholders are stripped before the turn is
   * sent, so matching attachments on the visible text loses them the instant
   * the echo lands. Matching uses this when it is set. */
  matchText?: string;
  parts: UIMessage["parts"];
  /** Parts already contain the display text and attachment positions. */
  orderedParts?: boolean;
  userMessageOrdinal?: number;
};

export type CodexSessionEntry = {
  /** Durable transcript was successfully read for this connection epoch. */
  canonicalReady?: boolean;
  canonicalEpoch?: number;
  warning?: string;
  session: CodexSession;
  messages: CodexTranscriptMessage[];
  items: CodexTrackedItem[];
  /** Latest Codex `update_plan` checklist, mirrored into the shared todo cache. */
  plan?: CodexPlanItem[];
  /** Unified-exec background processes the server tracks for this session. */
  backgroundProcesses: BackgroundProcess[];
  /** User messages submitted locally but not yet echoed back as a
   * `userMessage` stream item. Rendered optimistically so a sent/steered
   * message appears in the transcript immediately. */
  pendingUserMessages: CodexUserMessageRecord[];
  /** Accepted local messages retained after a turn fails before an echo. */
  settledUserMessages?: CodexUserMessageRecord[];
  /** Every user message this client sent for the session. The engine echoes
   * `userMessage` items as text only, so the parts captured here (an attached
   * image or file) are merged back onto the echoed message — without this an
   * attachment the user sent never appears in the transcript at all. */
  sentUserMessages: CodexUserMessageRecord[];
  activeTurnStartedAt?: number;
  subagentSessions?: CodexSession[];
};

type CodexSessionState = {
  sessions: Record<string, CodexSessionEntry>;
  loaded: boolean;
  streaming: boolean;
  error: string | null;
};

type CodexSessionActions = {
  replaceSessions: (sessions: CodexSession[], snapshot?: { workspaceId: string; entries: Record<string, CodexSessionEntry> }) => void;
  upsertSession: (session: CodexSession) => void;
  applyDelta: (sessionId: string, text: string) => void;
  applyThinkingDelta: (sessionId: string, text: string) => void;
  appendItemThinking: (sessionId: string, itemId: string, text: string) => void;
  upsertItem: (sessionId: string, item: CodexTrackedItem) => void;
  setBackgroundProcesses: (sessionId: string, processes: BackgroundProcess[]) => void;
  appendItemText: (sessionId: string, itemId: string, text: string) => void;
  appendItemOutput: (sessionId: string, itemId: string, text: string) => void;
  completeItem: (sessionId: string, itemId: string, item: Record<string, unknown>) => void;
  setThreadStatus: (sessionId: string, status: unknown) => void;
  setPlan: (sessionId: string, plan: CodexPlanItem[]) => void;
  startTurn: (sessionId: string) => void;
  completeTurn: (sessionId: string, outcome?: "completed" | "cancelled" | "failed") => void;
  failSession: (sessionId: string, message: string, turnId?: string) => void;
  setWarning: (sessionId: string, message: string | undefined) => void;
  addPendingUserMessage: (sessionId: string, text: string, parts?: UIMessage["parts"], matchText?: string, orderedParts?: boolean, userMessageOrdinal?: number) => void;
  confirmPendingUserMessage: (sessionId: string, text?: string, userMessageOrdinal?: number) => void;
  invalidateCanonical: (sessionId: string) => void;
  removeSession: (sessionId: string) => void;
  clear: () => void;
  setStreaming: (value: boolean) => void;
  setLoaded: (value: boolean) => void;
  setError: (value: string | null) => void;
};

export type CodexSessionStore = CodexSessionState & CodexSessionActions;

export const useCodexSessionStore = create<CodexSessionStore>((set, get) => ({
  sessions: {},
  loaded: false,
  streaming: false,
  error: null,

  replaceSessions: (sessions, snapshot) =>
    set((state) => {
      const next: Record<string, CodexSessionEntry> = { ...state.sessions };
      const fetchedIds = new Set(sessions.map(session => session.id));
      if (snapshot) {
        for (const [id, entry] of Object.entries(snapshot.entries)) {
          if (entry.session.workspaceId === snapshot.workspaceId && !fetchedIds.has(id) && state.sessions[id] === entry) {
            delete next[id];
          }
        }
      }
      for (const session of sessions) {
        const existing = state.sessions[session.id];
        if (snapshot && existing && existing !== snapshot.entries[session.id]) continue;
        next[session.id] = { ...(existing ?? { messages: [], items: [], backgroundProcesses: [], pendingUserMessages: [], sentUserMessages: [] }), session,
          ...(existing && existing.session.turnId !== session.turnId ? { canonicalReady: false, canonicalEpoch: (existing.canonicalEpoch ?? 0) + 1 } : {}) };

      }
      return { sessions: next, loaded: true };
    }),

  upsertSession: (session) =>
    set((state) => {
      const existing = state.sessions[session.id];
      return {
        sessions: {
          ...state.sessions,
          [session.id]: existing
            ? { ...existing, session, ...(existing.session.turnId !== session.turnId ? { canonicalReady: false, canonicalEpoch: (existing.canonicalEpoch ?? 0) + 1 } : {}) }
            : { session, messages: [], items: [], backgroundProcesses: [], pendingUserMessages: [], sentUserMessages: [] },
        },
      };
    }),

  upsertItem: (sessionId, item) =>
    set((state) => {
      const entry = state.sessions[sessionId];
      if (!entry) return state;
      const existing = entry.items.find((i) => i.id === item.id);
      const now = Date.now();
      const turnStartedAt=item.turnStartedAt ?? existing?.turnStartedAt ?? (item.historical ? undefined : entry.activeTurnStartedAt);
      const timedItem={...item,...(turnStartedAt===undefined?{}:{turnStartedAt})};
      const items = existing
        ? entry.items.map((i) => (i.id === item.id ? {
            ...i, ...timedItem, createdAt: item.createdAt ?? i.createdAt ?? now,
            status: i.status !== "pending" && item.status === "pending" ? i.status : item.status,
            text: i.text.length > item.text.length ? i.text : item.text,
            thinking: i.thinking.length > item.thinking.length ? i.thinking : item.thinking,
            output: i.output.length > item.output.length ? i.output : item.output,
          } : i))
        : [...entry.items, { ...timedItem, createdAt: item.createdAt ?? now }];
      return { sessions: { ...state.sessions, [sessionId]: { ...entry, items } } };
    }),

  appendItemText: (sessionId, itemId, text) =>
    set((state) => {
      const entry = state.sessions[sessionId];
      if (!entry) return state;
      const items = entry.items.map((i) => i.id === itemId ? { ...i, text: i.text + text } : i);
      return { sessions: { ...state.sessions, [sessionId]: { ...entry, items } } };
    }),

  appendItemOutput: (sessionId, itemId, text) =>
    set((state) => {
      const entry = state.sessions[sessionId];
      if (!entry) return state;
      const items = entry.items.map((i) => i.id === itemId ? { ...i, output: i.output + text } : i);
      return { sessions: { ...state.sessions, [sessionId]: { ...entry, items } } };
    }),

  completeItem: (sessionId, itemId, item) =>
    set((state) => {
      const entry = state.sessions[sessionId];
      if (!entry) return state;
      const now = Date.now();
      const items = entry.items.map((i) => i.id === itemId
        ? { ...i, item, createdAt: i.createdAt ?? now, completedAt: now, status: item.status === "failed" ? "error" as const : "done" as const, text: typeof item.text === "string" ? item.text : i.text }
        : i);
      return { sessions: { ...state.sessions, [sessionId]: { ...entry, items } } };
    }),

  setBackgroundProcesses: (sessionId, processes) =>
    set((state) => {
      const entry = state.sessions[sessionId];
      if (!entry) return state;
      return { sessions: { ...state.sessions, [sessionId]: { ...entry, backgroundProcesses: processes } } };
    }),

  setThreadStatus: (sessionId, status) =>
    set((state) => {
      const entry = state.sessions[sessionId];
      if (!entry) return state;
      const running = isRecord(status) && status.type === "active";
      const nextStatus: CodexSessionStatus = running ? "running" : (entry.session.status === "error" ? "error" : "idle");
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: { ...entry, session: { ...entry.session, status: nextStatus } },
        },
      };
    }),

  setPlan: (sessionId, plan) =>
    set((state) => {
      const entry = state.sessions[sessionId];
      if (!entry) return state;
      return { sessions: { ...state.sessions, [sessionId]: { ...entry, plan } } };
    }),

  applyDelta: (sessionId, text) =>
    set((state) => {
      const entry = state.sessions[sessionId];
      if (!entry) return state;
      const last = entry.messages[entry.messages.length - 1];
      if (last && last.role === "assistant" && last.status !== "done") {
        const messages = [...entry.messages];
        messages[messages.length - 1] = { ...last, text: last.text + text };
        return { sessions: { ...state.sessions, [sessionId]: { ...entry, messages } } };
      }
      const messages = [
        ...entry.messages,
        { id: `${sessionId}:assistant:${entry.messages.length}`, role: "assistant" as const, text, thinking: "", status: "pending" as const },
      ];
      return { sessions: { ...state.sessions, [sessionId]: { ...entry, messages } } };
    }),

  applyThinkingDelta: (sessionId, text) =>
    set((state) => {
      const entry = state.sessions[sessionId];
      if (!entry) return state;
      const last = entry.messages[entry.messages.length - 1];
      if (last && last.role === "assistant" && last.status !== "done") {
        const messages = [...entry.messages];
        messages[messages.length - 1] = { ...last, thinking: (last.thinking ?? "") + text };
        return { sessions: { ...state.sessions, [sessionId]: { ...entry, messages } } };
      }
      const messages = [
        ...entry.messages,
        { id: `${sessionId}:assistant:${entry.messages.length}`, role: "assistant" as const, text: "", thinking: text, status: "pending" as const },
      ];
      return { sessions: { ...state.sessions, [sessionId]: { ...entry, messages } } };
    }),

  appendItemThinking: (sessionId, itemId, text) =>
    set((state) => {
      const entry = state.sessions[sessionId];
      if (!entry) return state;
      const items = entry.items.map((i) =>
        i.id === itemId ? { ...i, thinking: (i.thinking ?? "") + text } : i,
      );
      return { sessions: { ...state.sessions, [sessionId]: { ...entry, items } } };
    }),

  startTurn: (sessionId) =>
    set((state) => {
      const entry = state.sessions[sessionId];
      if (!entry) return state;
      const messages = [...entry.messages];
      const last = messages[messages.length - 1];
      if (last && last.role === "assistant") {
        messages[messages.length - 1] = { ...last, status: "pending" };
      }
      return {
        sessions: { ...state.sessions, [sessionId]: { ...entry, ...(entry.session.status !== "running" ? { canonicalReady: false, canonicalEpoch: (entry.canonicalEpoch ?? 0) + 1 } : {}), activeTurnStartedAt: entry.activeTurnStartedAt ?? Date.now(), session: { ...entry.session, status: "running" }, messages } },
      };
    }),

  completeTurn: (sessionId, outcome) =>
    set((state) => {
      const entry = state.sessions[sessionId];
      if (!entry) return state;
      const messages = entry.messages.map((message, index) =>
        index === entry.messages.length - 1 && message.role === "assistant" ? { ...message, status: "done" as const } : message,
      );
      // The session update may have cleared turnId before this notification.
      // Bind the outcome to the latest tracked turn, never infer it from idle.
      const turnId = entry.session.turnId ?? entry.items.at(-1)?.turnId;
      const completedAt = Date.now();
      const items = entry.items.map((item) => ({
        ...item,
        ...(item.turnId === turnId && item.status === "pending" ? { status: "done" as const, completedAt } : {}),
        ...(turnId && item.turnId === turnId ? { turnCompletedAt: item.turnCompletedAt ?? completedAt } : {}),
        ...(outcome && turnId && item.turnId === turnId ? { turnOutcome: outcome } : {}),
      }));
      return {
        sessions: { ...state.sessions, [sessionId]: { ...entry, activeTurnStartedAt: undefined, session: { ...entry.session, status: "idle" }, messages, items } },
      };
    }),

  failSession: (sessionId, message, turnId) =>
    set((state) => {
      const entry = state.sessions[sessionId];
      if (!entry) return state;
      const messages = [...entry.messages];
      const last = messages[messages.length - 1];
      if (last && last.role === "assistant") {
        messages[messages.length - 1] = { ...last, status: "error" };
      }
      const failureTurnId = turnId ?? entry.session.turnId;
      const id = `sofia-error:${failureTurnId ?? entry.items.length}`;
      const items: CodexTrackedItem[] = entry.items
        .filter((item) => item.id !== id)
        .map((item) => item.status === "pending" ? { ...item, status: "error" } : item);
      const described = describeSofiaError(message);
      const errorPresentation: WorkspaceEngineSessionErrorPresentation = {
        kind: "generic",
        title: described.title,
        description: described.body,
        technicalDetails: described.raw,
        recoveryPrompt: null,
      };
      items.push({
        id, type: "agentMessage", turnId: failureTurnId ?? id,
        item: { id, type: "agentMessage", text: described.title },
        text: described.title, thinking: "", output: "", status: "error",
        errorPresentation,
      });
      return {
        error: message,
        sessions: {
          ...state.sessions,
          [sessionId]: { ...entry, activeTurnStartedAt: undefined, session: { ...entry.session, status: "error" }, messages, items, settledUserMessages: [...(entry.settledUserMessages ?? []), ...entry.pendingUserMessages], pendingUserMessages: [] },
        },
      };
    }),

  /**
   * Show (or clear) a session-level notice above the transcript. Used for
   * engine warnings and for states the user would otherwise only see as an
   * empty pane — a task held by another Sofia process, or a transcript that
   * could not be loaded.
   */
  setWarning: (sessionId, message) =>
    set((state) => {
      const entry = state.sessions[sessionId];
      if (!entry || entry.warning === message) return state;
      return { sessions: { ...state.sessions, [sessionId]: { ...entry, warning: message } } };
    }),

  // Optimistically render a sent/steered user message until the engine echoes
  // it back as a `userMessage` item (see confirmPendingUserMessage).
  addPendingUserMessage: (sessionId, text, parts, matchText, orderedParts, userMessageOrdinal) =>
    set((state) => {
      const entry = state.sessions[sessionId];
      const trimmed = text.trim();
      if (!entry || (!trimmed && !parts?.length)) return state;
      const match = matchText?.trim();
      const record: CodexUserMessageRecord = {
        ...(entry.items.length ? { afterItemId: entry.items[entry.items.length - 1].id } : {}),
        text: trimmed,
        ...(match ? { matchText: match } : {}),
        parts: parts ?? [],
        ...(orderedParts ? { orderedParts: true } : {}),
        ...(userMessageOrdinal !== undefined ? { userMessageOrdinal } : {}),
      };
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...entry,
            pendingUserMessages: [...entry.pendingUserMessages, record],
            // Kept after the echo too, so the parts can be merged back onto the
            // text-only `userMessage` item the engine sends. Bounded so a long
            // session cannot grow without limit.
            sentUserMessages: [...entry.sentUserMessages, record].slice(-100),
          },
        },
      };
    }),

  confirmPendingUserMessage: (sessionId, text, userMessageOrdinal) =>
    set((state) => {
      const entry = state.sessions[sessionId];
      if (!entry) return state;
      const trimmed = typeof text === "string" ? text.trim() : "";
      const matches = (message: CodexUserMessageRecord) =>
        (userMessageOrdinal === undefined || message.userMessageOrdinal === undefined || message.userMessageOrdinal === userMessageOrdinal) &&
        (message.text === trimmed || (message.matchText ?? message.text).trim() === trimmed);
      const pendingIndex = entry.pendingUserMessages.findIndex(matches);
      const settledIndex = (entry.settledUserMessages ?? []).findIndex(matches);
      // Replayed/unrelated user items cannot remove another submission.
      if (pendingIndex < 0 && settledIndex < 0) return state;
      return { sessions: { ...state.sessions, [sessionId]: {
        ...entry,
        pendingUserMessages: entry.pendingUserMessages.filter((_, index) => index !== pendingIndex),
        settledUserMessages: (entry.settledUserMessages ?? []).filter((_, index) => index !== settledIndex),
      } } };

    }),

  invalidateCanonical: (sessionId) => set(state => {
    const entry = state.sessions[sessionId];
    return entry ? { sessions: { ...state.sessions, [sessionId]: { ...entry, canonicalReady: false, canonicalEpoch: (entry.canonicalEpoch ?? 0) + 1 } } } : state;
  }),

  removeSession: (sessionId) =>
    set((state) => {
      const next = { ...state.sessions };
      delete next[sessionId];
      return { sessions: next };
    }),

  clear: () => set({ sessions: {}, loaded: false }),
  setStreaming: (streaming) => set({ streaming }),
  setLoaded: (loaded) => set({ loaded }),
  setError: (error) => set({ error }),
}));

/**
 * Drive the store from a live codex stream for one workspace. Reconnects with
 * a backoff on unexpected closes; stops when the AbortSignal fires.
 */
export async function runCodexStream(
  client: CodexSessionClient,
  signal: AbortSignal,
  onEvent?: (event: CodexEvent) => void,
  workspaceId?: string,
): Promise<void> {
  const store = useCodexSessionStore.getState();
  store.setStreaming(true);
  store.setError(null);
  for (let attempt = 1; !signal.aborted; attempt++) {
    try {
      await client.stream(signal, (event) => {
        const s = useCodexSessionStore.getState();
        switch (event.type) {
          case "stream.ready":
            s.setStreaming(true);
            s.setError(null);
            refreshTrackedBackgroundProcesses(workspaceId);
            break;
          case "session.created":
          case "session.updated":
            s.upsertSession({ ...event.session, workspaceId: workspaceId ?? event.session.workspaceId });
            break;
          case "message.delta":
            // Append into the agentMessage item so it renders live in order;
            // fall back to the assistant message when there's no item id yet.
            if (event.itemId) s.appendItemText(event.sessionId, event.itemId, event.text);
            else s.applyDelta(event.sessionId, event.text);
            break;
          case "thinking.delta":
            // Populate the reasoning item so its thinking block renders live;
            // fall back to the assistant message when there's no item id yet.
            if (event.itemId) s.appendItemThinking(event.sessionId, event.itemId, event.text);
            else s.applyThinkingDelta(event.sessionId, event.text);
            break;
          case "item.started": {
            const item = isRecord(event.item) ? event.item : {};
            const itemId = typeof item.id === "string" ? item.id : event.itemType;
            const turnId = typeof event.turnId === "string" ? event.turnId : itemId;
            s.upsertItem(event.sessionId, {
              id: itemId,
              type: event.itemType,
              turnId,
              item,
              text: "",
              thinking: "",
              output: "",
              status: "pending",
            });
            if (event.itemType === "userMessage") {
              const ordinal = useCodexSessionStore.getState().sessions[event.sessionId]?.items.filter((tracked) => tracked.type === "userMessage").findIndex((tracked) => tracked.id === itemId);
              s.confirmPendingUserMessage(event.sessionId, userMessageText(item), ordinal);
            }
            // Replayed starts cannot reopen an item/turn already completed.
            if (useCodexSessionStore.getState().sessions[event.sessionId]?.items.find((tracked) => tracked.id === itemId)?.status === "pending") {
              s.startTurn(event.sessionId);
            }
            break;
          }
          case "item.completed": {
            const item = isRecord(event.item) ? event.item : {};
            const itemId = typeof item.id === "string" ? item.id : event.itemType;
            if (!s.sessions[event.sessionId]?.items.some((tracked) => tracked.id === itemId)) {
              s.upsertItem(event.sessionId, {
                id: itemId, type: event.itemType, turnId: event.turnId, item,
                text: "", thinking: "", output: "", status: "pending",
              });
            }
            s.completeItem(event.sessionId, itemId, item);
            // The engine echoed a submitted user message: drop the optimistic
            // pending copy so it isn't rendered twice.
            if (event.itemType === "userMessage") {
              const ordinal = useCodexSessionStore.getState().sessions[event.sessionId]?.items.filter((tracked) => tracked.type === "userMessage").findIndex((tracked) => tracked.id === itemId);
              s.confirmPendingUserMessage(event.sessionId, userMessageText(item), ordinal);
            }
            break;
          }
          case "plan.updated":
            // Update_plan checklist: keep it on the entry so the transcript
            // adapter can mirror it into the shared todo cache.
            s.setPlan(event.sessionId, event.plan);
            break;
          case "backgroundProcesses":
            s.setBackgroundProcesses(event.sessionId, event.processes);
            break;
          case "tool.output":
            // Command output streams live into the owning command item.
            s.appendItemOutput(event.sessionId, event.itemId, event.text);
            break;
          case "thread.status":
            s.setThreadStatus(event.sessionId, event.status);
            break;
          case "turn.changes":
            restoreRecordedTurnChanges(event.changes);
            break;
          case "turn.completed":
            if (workspaceId) useSessionActivityStore.getState().completePreview(workspaceId, event.sessionId, event.outcome);
            s.completeTurn(event.sessionId, event.outcome);
            break;
          case "warning": {
            s.setWarning(event.sessionId, event.message);
            break;
          }
          case "error":
            if (workspaceId) useSessionActivityStore.getState().completePreview(workspaceId, event.sessionId, "failed");
            s.failSession(event.sessionId, event.message, event.turnId);
            break;
          default:
            break;
        }
        onEvent?.(event);
      });
      if (!signal.aborted) throw new Error("Sofia connection closed; reconnecting");
    } catch (error) {
      if (signal.aborted) break;
      store.setStreaming(false);
      for (const entry of Object.values(useCodexSessionStore.getState().sessions)) {
        if (!workspaceId || entry.session.workspaceId === workspaceId) store.invalidateCanonical(entry.session.id);
      }
      store.setError(error instanceof Error ? error.message : "Sofia stream disconnected");
      await new Promise<void>((resolve) => {
        const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
        const timer = setTimeout(done, Math.min(500 * attempt, 5_000));
        signal.addEventListener("abort", done, { once: true });
      });
    }
  }
  store.setStreaming(false);
}

export function useCodexSessionsForWorkspace(workspaceId: string): CodexSessionEntry[] {
  const sessions = useCodexSessionStore((state) => state.sessions);
  return Object.values(sessions).filter((entry) => entry.session.workspaceId === workspaceId);
}

export function useCodexSession(sessionId: string): CodexSessionEntry | null {
  return useCodexSessionStore((state) => state.sessions[sessionId] ?? null);
}

export function useCodexSessionStatus(sessionId: string): CodexSessionStatus | null {
  return useCodexSessionStore((state) => state.sessions[sessionId]?.session.status ?? null);
}

/**
 * One codex client per workspace, registered by `useCodexEngine`. The SSE
 * stream stays the live source of truth; these helpers let the background
 * process UI reconcile/terminate outside the stream.
 */
const codexClientsByWorkspace = new Map<string, CodexSessionClient>();

export function setCodexClient(workspaceId: string, client: CodexSessionClient | null): void {
  if (client) codexClientsByWorkspace.set(workspaceId, client);
  else codexClientsByWorkspace.delete(workspaceId);
}

/** The codex client bound to a session's workspace, if any — the fallback for
 * change tracking when no engine client is available. */
export function codexClientForSession(sessionId: string): CodexSessionClient | null {
  const entry = useCodexSessionStore.getState().sessions[sessionId];
  if (!entry) return null;
  return codexClientsByWorkspace.get(entry.session.workspaceId) ?? null;
}

/**
 * Reconcile the local view with the server registry. The renderer's cache is
 * transient (a missed stream frame, a reconnect); the server is authoritative,
 * so session open and reconnect call this.
 */
export async function refreshBackgroundProcesses(sessionId: string): Promise<void> {
  const client = codexClientForSession(sessionId);
  if (!client) return;
  try {
    const { processes } = await client.backgroundProcesses(sessionId);
    useCodexSessionStore.getState().setBackgroundProcesses(sessionId, processes);
  } catch {
    // Offline or reconnecting: keep the last known view.
  }
}

/**
 * Reconcile every session on a workspace that already tracks processes. Called
 * on stream (re)connect so a process that exited while the renderer was offline
 * does not stay stuck as "running".
 */
export function refreshTrackedBackgroundProcesses(workspaceId: string | undefined): void {
  if (!workspaceId) return;
  const sessions = Object.values(useCodexSessionStore.getState().sessions)
    .filter((entry) => entry.session.workspaceId === workspaceId && entry.backgroundProcesses.length > 0);
  for (const entry of sessions) void refreshBackgroundProcesses(entry.session.id);
}

export async function terminateBackgroundProcess(sessionId: string, processId: string): Promise<boolean> {
  const client = codexClientForSession(sessionId);
  if (!client) return false;
  const { terminated } = await client.terminateBackgroundProcess(sessionId, processId);
  await refreshBackgroundProcesses(sessionId);
  return terminated;
}

export async function cleanBackgroundProcesses(sessionId: string): Promise<void> {
  const client = codexClientForSession(sessionId);
  if (!client) return;
  await client.cleanBackgroundProcesses(sessionId);
  await refreshBackgroundProcesses(sessionId);
}

const EMPTY_BACKGROUND_PROCESSES: BackgroundProcess[] = [];

/** A background process that exited in a way the user needs to know about. */
/** Human title for the failure notification (command + exit code when known). */
export function backgroundProcessFailureTitle(process: BackgroundProcess): string {
  const command = process.command.trim() || "Background process";
  const label = command.length > 60 ? `${command.slice(0, 59)}...` : command;
  return typeof process.exitCode === "number"
    ? `${label} exited with code ${process.exitCode}`
    : `${label} failed`;
}

/**
 * Live repository read for the review pane's Unstaged/Staged scopes — the scopes
 * that are *supposed* to change. Turn patches no longer go through here: those
 * come from the workspace-scoped snapshot diff in changes/turn-change-tracking.
 */
export async function loadRepositoryChanges(
  sessionId: string,
  scope: "unstaged" | "staged",
): Promise<FileChange[] | null> {
  const client = codexClientForSession(sessionId);
  if (!client?.workspaceChanges) return null;
  try {
    const response = await client.workspaceChanges(sessionId, { hunks: true, scope });
    return response.files.map((file) => ({ ...file, attributedToTurn: true }));
  } catch {
    return null;
  }
}

export function useBackgroundProcesses(sessionId: string): BackgroundProcess[] {
  return useCodexSessionStore((state) => state.sessions[sessionId]?.backgroundProcesses ?? EMPTY_BACKGROUND_PROCESSES);
}
