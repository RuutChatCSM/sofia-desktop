// Cross-workspace attention hub.
//
// `apps/server` owns observation of work, not the renderer. Each workspace's
// CodexSessionManager keeps its engine listeners attached whether or not a
// renderer is subscribed, so a background process that fails is noticed here
// even while the user is looking at another workspace. The hub collects those
// transitions and delivers them to whoever is connected — and replays events
// that arrived while nobody was (app closed, stream reconnecting) until the
// renderer acknowledges them.
import { EventEmitter } from "node:events";

import type { CodexEvent } from "./codex-sessions.js";

export type CodexAttentionEvent = Extract<CodexEvent, { type: "backgroundProcess.failed" }>;

/** Bound the replay buffer so a long-lived server cannot grow forever. */
const MAX_PENDING = 100;

type ObservableManager = {
  on: (listener: (event: CodexEvent) => void) => () => void;
};

export type AttentionAck = { sessionId: string; itemId: string };

export function attentionKey(event: Pick<CodexAttentionEvent, "sessionId" | "itemId">): string {
  return `${event.sessionId}:${event.itemId}:failed`;
}

export class CodexAttentionHub {
  private emitter = new EventEmitter();
  private observed = new Map<string, ObservableManager>();
  private pending = new Map<string, CodexAttentionEvent>();

  constructor() {
    this.emitter.setMaxListeners(50);
  }

  /**
   * Subscribe once per live manager. Keyed by instance (not just workspace) so a
   * manager replaced after an engine restart is observed again.
   */
  observe(workspaceId: string, manager: ObservableManager): void {
    if (this.observed.get(workspaceId) === manager) return;
    this.observed.set(workspaceId, manager);
    manager.on((event) => {
      if (event.type !== "backgroundProcess.failed") return;
      const key = attentionKey(event);
      this.pending.delete(key);
      this.pending.set(key, event);
      if (this.pending.size > MAX_PENDING) {
        const oldest = this.pending.keys().next().value;
        if (oldest !== undefined) this.pending.delete(oldest);
      }
      this.emitter.emit("attention", event);
    });
  }

  /** Live attention events. Callers replay pending events on connect. */
  on(listener: (event: CodexAttentionEvent) => void): () => void {
    this.emitter.on("attention", listener);
    return () => { this.emitter.off("attention", listener); };
  }

  pendingEvents(): CodexAttentionEvent[] {
    return [...this.pending.values()];
  }

  /** The renderer has surfaced this event (attention + notification). */
  acknowledge(ack: AttentionAck): void {
    this.pending.delete(`${ack.sessionId}:${ack.itemId}:failed`);
  }
}
