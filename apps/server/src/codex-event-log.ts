import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

import type { CodexEvent } from "./codex-sessions.js";

export type SequencedCodexEvent = CodexEvent & { seq: number };

type ObservableManager = { on: (listener: (event: CodexEvent) => void) => () => void };

/**
 * Numbered recent events for one workspace manager. A client that reconnects
 * with the last number it saw gets exactly the events it missed, instead of a
 * full session re-list and a history re-read of every open transcript.
 * `epoch` changes when the log is recreated (server restart), which tells the
 * client its numbers no longer apply.
 */
export class CodexEventLog {
  readonly epoch = randomUUID();
  private entries: SequencedCodexEvent[] = [];
  private seq = 0;
  private emitter = new EventEmitter();

  constructor(manager: ObservableManager, private readonly capacity = 5_000) {
    this.emitter.setMaxListeners(50);
    manager.on((event) => {
      const entry = { ...event, seq: ++this.seq };
      this.entries.push(entry);
      if (this.entries.length > this.capacity) this.entries.splice(0, this.entries.length - this.capacity);
      this.emitter.emit("event", entry);
    });
  }

  get lastSeq(): number {
    return this.seq;
  }

  /** Events after `seq`, or null when they are no longer retained. */
  since(seq: number): SequencedCodexEvent[] | null {
    if (!Number.isInteger(seq) || seq < 0 || seq > this.seq) return null;
    const oldest = this.entries[0]?.seq ?? this.seq + 1;
    if (seq < oldest - 1) return null;
    return this.entries.filter((entry) => entry.seq > seq);
  }

  on(listener: (event: SequencedCodexEvent) => void): () => void {
    this.emitter.on("event", listener);
    return () => { this.emitter.off("event", listener); };
  }
}

const logs = new WeakMap<ObservableManager, CodexEventLog>();

export function eventLogFor(manager: ObservableManager): CodexEventLog {
  let log = logs.get(manager);
  if (!log) {
    log = new CodexEventLog(manager);
    logs.set(manager, log);
  }
  return log;
}
