import type { UIMessage } from "ai";

import type { AnyToolPart } from "@/lib/tool-aggregate";

import { getAggregateOnlyParts } from "./utils";
import { messagePhase, turnAnswerIndex } from "./turn-structure";

export type UIMessageWithIndex = { index: number; message: UIMessage };

/**
 * How a turn reads in the transcript: one work disclosure, then the answer.
 *
 *   work    everything the turn did, in the order it did it — commentary
 *           (`phase: "commentary"` progress prose), aggregated tool milestones
 *           ("Ran 2 commands"), and individual tool/reasoning detail
 *   answer  the turn's final prose, and the only row that escapes the disclosure
 *
 * The grouping is a product statement, not a styling choice: an execution
 * narrative is not a series of conversation messages. Rendering protocol
 * boundaries as sibling transcript rows is what made a long turn read as an IDE
 * log — each row carrying its own message-group spacing, which no gap rule could
 * close — and hiding the milestones is what made it read as silence.
 */
export type TurnWorkEntry =
  | { kind: "commentary"; key: string; item: UIMessageWithIndex }
  | { kind: "milestone"; key: string; parts: AnyToolPart[] }
  | { kind: "detail"; key: string; item: UIMessageWithIndex };

export type TurnPresentation = {
  /** The turn's whole execution narrative, chronological, inside the disclosure. */
  work: TurnWorkEntry[];
  /** The turn's answer: rendered outside the disclosure, below it. */
  answerItems: UIMessageWithIndex[];
};

function isCommentary(item: UIMessageWithIndex): boolean {
  return (
    item.message.role === "assistant"
    && messagePhase(item.message) === "commentary"
  );
}

function aggregatePartsFor(item: UIMessageWithIndex, showThinking: boolean): AnyToolPart[] {
  if (item.message.role !== "assistant") return [];
  return getAggregateOnlyParts(item.message, showThinking) ?? [];
}

export function deriveTurnPresentation(
  items: readonly UIMessageWithIndex[],
  showThinking: boolean,
): TurnPresentation {
  const ordered = [...items].sort((left, right) => left.index - right.index);
  // The answer is the turn's trailing prose; `commentary` never answers a turn.
  const answerIndex = turnAnswerIndex(ordered.map((item) => item.message));

  const work: TurnWorkEntry[] = [];
  const answerItems: UIMessageWithIndex[] = [];
  let run: (TurnWorkEntry & { kind: "milestone" }) | null = null;

  const flush = () => {
    if (!run) return;
    work.push(run);
    run = null;
  };

  ordered.forEach((item, position) => {
    if (position === answerIndex) {
      flush();
      answerItems.push(item);
      return;
    }
    if (isCommentary(item)) {
      // Commentary interrupts a run of tool events rather than joining it.
      flush();
      work.push({ kind: "commentary", key: `commentary-${item.message.id}`, item });
      return;
    }
    const aggregateParts = aggregatePartsFor(item, showThinking);
    if (aggregateParts.length > 0) {
      if (!run) run = { kind: "milestone", key: `milestone-${item.message.id}`, parts: [] };
      run.parts.push(...aggregateParts);
      return;
    }
    // Reasoning and individual tool detail: still part of the same narrative.
    flush();
    work.push({ kind: "detail", key: `detail-${item.message.id}`, item });
  });
  flush();

  return { work, answerItems };
}
