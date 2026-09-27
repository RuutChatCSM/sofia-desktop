import type { UIMessage } from "ai";

import type { AnyToolPart } from "@/lib/tool-aggregate";
import { getAssistantRenderGroups, splitTurnAtAnswer } from "./utils";
import { turnAnswerIndex } from "./turn-structure";

export type UIMessageWithIndex = { index: number; message: UIMessage };

export type TurnWorkEntry =
  | { kind: "commentary"; key: string; item: UIMessageWithIndex }
  | { kind: "milestone"; key: string; parts: AnyToolPart[] }
  | {
      kind: "thought"
      key: string
      text: string
      isStreaming: boolean
      /**
       * The phase Sofia is in right now — the turn's trailing work, so the reader
       * can see her thinking. Every earlier phase is history and stays folded.
       */
      isCurrent: boolean
    }
  | { kind: "detail"; key: string; item: UIMessageWithIndex };

export type TurnPresentation = {
  work: TurnWorkEntry[];
  answerItems: UIMessageWithIndex[];
};

/** Project parts, not protocol messages: one message may carry all three channels. */
export function workEntriesForMessage(
  item: UIMessageWithIndex,
  _showThinking: boolean,
): TurnWorkEntry[] {
  return getAssistantRenderGroups(item.message.parts, true).map((group, index) => {
    const key = `${item.message.id}:${index}`;
    if (group.kind === "reasoning") {
      return {
        kind: "thought" as const,
        key,
        text: group.text,
        isStreaming: group.isStreaming,
        isCurrent: false,
      };
    }
    if (group.kind === "tool-aggregate") return { kind: "milestone", key, parts: group.parts };
    const parts: UIMessage["parts"] = group.kind === "text"
      ? [{ type: "text", text: group.text }]
      : [group.part];
    return {
      kind: group.kind === "text" ? "commentary" : "detail",
      key,
      item: { ...item, message: { ...item.message, parts } },
    };
  });
}

/**
 * Work stays compact; reasoning remains available in its own disclosure.
 *
 * Reasoning is a *phase*, not a packet. The stream arrives as a run of
 * consecutive reasoning items, and a row per item renders the model's chunking
 * as "Thought, Thought, Thought". Consecutive packets cluster into one
 * `thought`, closed by whatever Sofia does next: commentary, a tool run, the
 * answer, or the end of the turn. Placement stays chronological — a phase is
 * never hoisted to the top or bottom of the turn.
 */
export function deriveTurnPresentation(
  items: readonly UIMessageWithIndex[],
  showThinking: boolean,
): TurnPresentation {
  const ordered = [...items].sort((left, right) => left.index - right.index);
  const answerIndex = turnAnswerIndex(ordered.map((item) => item.message));
  const work: TurnWorkEntry[] = [];
  const answerItems: UIMessageWithIndex[] = [];
  // Mutated through an object rather than plain `let`s: these are written from
  // the append closure, and a write inside a closure is invisible to flow
  // analysis, which would otherwise narrow them to `null` at the end.
  const phase: {
    run: (TurnWorkEntry & { kind: "milestone" }) | null
    thought: (TurnWorkEntry & { kind: "thought" }) | null
  } = { run: null, thought: null };

  const append = (entry: TurnWorkEntry) => {
    if (entry.kind === "thought") {
      const open = phase.thought;
      if (open) {
        // One phase: the packets are the runtime's boundaries, not the reader's.
        open.text = open.text ? `${open.text}\n\n${entry.text}` : entry.text;
        open.isStreaming = open.isStreaming || entry.isStreaming;
        return;
      }
      const opened = { ...entry };
      phase.thought = opened;
      work.push(opened);
      return;
    }

    // Commentary, a tool run or a detail ends the phase.
    phase.thought = null;

    if (entry.kind === "milestone") {
      // A thought between calls does not turn one tool summary into many rows.
      if (phase.run) phase.run.parts.push(...entry.parts);
      else {
        const opened = { ...entry, parts: [...entry.parts] };
        phase.run = opened;
        work.push(opened);
      }
      return;
    }

    phase.run = null;
    work.push(entry);
  };

  ordered.forEach((item, position) => {
    if (position === answerIndex) {
      const split = splitTurnAtAnswer(item.message);
      if (split) {
        workEntriesForMessage({ ...item, message: split.steps }, showThinking).forEach(append);
        answerItems.push({ ...item, message: split.answer });
      } else {
        answerItems.push(item);
      }
      // The answer ends the phase as surely as commentary does: she is not still
      // thinking the thing she has just said.
      phase.thought = null;
      return;
    }
    workEntriesForMessage(item, showThinking).forEach(append);
  });

  // Only the trailing phase is "now". Once Sofia says or does something, the
  // phase behind it is history.
  if (phase.thought) phase.thought.isCurrent = true;

  return { work, answerItems };
}
