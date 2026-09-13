// Codex session store: holds codex engine sessions and their transcripts as
// accumulated from the SSE stream. Mirrors the opencode session surface enough
// to drive the existing transcript UI: each session accumulates a text body
// from `message.delta`, and status from `item.*` / `turn.completed`.
import { create } from "zustand";

import type { CodexEvent, CodexSession, CodexSessionClient, CodexSessionStatus } from "@/app/lib/codex-session";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type CodexTranscriptMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  thinking: string;
  status: "pending" | "done" | "error";
};

/** A codex ThreadItem as tracked by the store: its type, opencode-translated
 * parts, and live accumulator buffers for deltas. */
export type CodexTrackedItem = {
  id: string;
  type: string;
  turnId: string;      // groups items of one user exchange into a single turn
  item: Record<string, unknown>;
  text: string;        // accumulated agentMessage/command output
  thinking: string;    // accumulated reasoning
  output: string;      // accumulated command output
  status: "pending" | "done" | "error";
};

export type CodexSessionEntry = {
  session: CodexSession;
  messages: CodexTranscriptMessage[];
  items: CodexTrackedItem[];
};

type CodexSessionState = {
  sessions: Record<string, CodexSessionEntry>;
  loaded: boolean;
  streaming: boolean;
  error: string | null;
};

type CodexSessionActions = {
  replaceSessions: (sessions: CodexSession[]) => void;
  upsertSession: (session: CodexSession) => void;
  applyDelta: (sessionId: string, text: string) => void;
  applyThinkingDelta: (sessionId: string, text: string) => void;
  appendItemThinking: (sessionId: string, itemId: string, text: string) => void;
  upsertItem: (sessionId: string, item: CodexTrackedItem) => void;
  appendItemText: (sessionId: string, itemId: string, text: string) => void;
  appendItemOutput: (sessionId: string, itemId: string, text: string) => void;
  completeItem: (sessionId: string, itemId: string, item: Record<string, unknown>) => void;
  setThreadStatus: (sessionId: string, status: unknown) => void;
  startTurn: (sessionId: string) => void;
  completeTurn: (sessionId: string) => void;
  failSession: (sessionId: string, message: string) => void;
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

  replaceSessions: (sessions) =>
    set((state) => {
      const next: Record<string, CodexSessionEntry> = {};
      for (const session of sessions) {
        next[session.id] = { ...(state.sessions[session.id] ?? { messages: [], items: [] }), session };
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
            ? { ...existing, session }
            : { session, messages: [], items: [] },
        },
      };
    }),

  upsertItem: (sessionId, item) =>
    set((state) => {
      const entry = state.sessions[sessionId];
      if (!entry) return state;
      const existing = entry.items.find((i) => i.id === item.id);
      const items = existing
        ? entry.items.map((i) => (i.id === item.id ? { ...i, ...item, text: i.text || item.text, thinking: i.thinking || item.thinking, output: i.output || item.output } : i))
        : [...entry.items, item];
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
      const items = entry.items.map((i) => i.id === itemId
        ? { ...i, item, status: item.status === "failed" ? "error" as const : "done" as const, text: typeof item.text === "string" ? item.text : i.text }
        : i);
      return { sessions: { ...state.sessions, [sessionId]: { ...entry, items } } };
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
        sessions: { ...state.sessions, [sessionId]: { ...entry, session: { ...entry.session, status: "running" }, messages } },
      };
    }),

  completeTurn: (sessionId) =>
    set((state) => {
      const entry = state.sessions[sessionId];
      if (!entry) return state;
      const messages = entry.messages.map((message, index) =>
        index === entry.messages.length - 1 && message.role === "assistant" ? { ...message, status: "done" as const } : message,
      );
      const items = entry.items.map((item) => item.status === "pending" ? { ...item, status: "done" as const } : item);
      return {
        sessions: { ...state.sessions, [sessionId]: { ...entry, session: { ...entry.session, status: "idle" }, messages, items } },
      };
    }),

  failSession: (sessionId, message) =>
    set((state) => {
      const entry = state.sessions[sessionId];
      if (!entry) return state;
      const messages = [...entry.messages];
      const last = messages[messages.length - 1];
      if (last && last.role === "assistant") {
        messages[messages.length - 1] = { ...last, status: "error" };
      }
      return {
        error: message,
        sessions: {
          ...state.sessions,
          [sessionId]: { ...entry, session: { ...entry.session, status: "error" }, messages },
        },
      };
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
            s.startTurn(event.sessionId);
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
            break;
          }
          case "tool.output":
            // Command output streams live into the owning command item.
            s.appendItemOutput(event.sessionId, event.itemId, event.text);
            break;
          case "thread.status":
            s.setThreadStatus(event.sessionId, event.status);
            break;
          case "turn.completed":
            s.completeTurn(event.sessionId);
            break;
          case "error":
            s.failSession(event.sessionId, event.message);
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
