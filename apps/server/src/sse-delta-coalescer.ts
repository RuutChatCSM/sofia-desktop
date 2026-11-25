import type { CodexEvent } from "./codex-sessions.js";

type TextDelta = Extract<CodexEvent, { type: "message.delta" | "thinking.delta" }>;

function isTextDelta<E extends CodexEvent>(event: E): event is E & TextDelta {
  return event.type === "message.delta" || event.type === "thinking.delta";
}

function sameStream(a: TextDelta, b: TextDelta): boolean {
  return a.type === b.type && a.sessionId === b.sessionId && a.itemId === b.itemId && a.threadId === b.threadId;
}

/**
 * Merge consecutive text deltas for the same item into one event per window.
 *
 * Models stream a delta per token; forwarding each one made the renderer
 * apply hundreds of store updates a second. Any other event flushes the
 * pending text first, so ordering relative to item and turn events is kept.
 */
export function createDeltaCoalescer<E extends CodexEvent>(send: (event: E) => void, windowMs = 50) {
  let pending: (E & TextDelta) | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    const event = pending;
    pending = null;
    if (event) send(event);
  };
  return {
    push(event: E) {
      if (!isTextDelta(event)) {
        flush();
        send(event);
        return;
      }
      if (pending && sameStream(pending, event)) {
        // Later fields win (e.g. a sequence number), text accumulates.
        pending = { ...event, text: pending.text + event.text };
        return;
      }
      flush();
      pending = { ...event };
      timer = setTimeout(flush, windowMs);
    },
    flush,
  };
}
