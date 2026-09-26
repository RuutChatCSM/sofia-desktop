import type { UIMessage } from "ai";

import type { AnyToolPart } from "@/lib/tool-aggregate";

import { getAggregateOnlyParts } from "./utils";
import { messagePhase, turnAnswerIndex } from "./turn-structure";

export type UIMessageWithIndex = { index: number; message: UIMessage };

/**
 * How a turn reads in the transcript.
 *
 * Three layers, deliberately distinct:
 *
 *   work       reasoning + individual tool detail — collapsed behind the
 *              "Worked for …" disclosure (the execution trail)
 *   milestone  consecutive tool events aggregated into one visible row
 *              ("Ran 2 commands", "Edited 1 file, ran 1 command")
 *   commentary progress prose the protocol marks `phase: "commentary"`, written
 *              for the user to read while Sofia works
 *   answer     the turn's final prose
 *
 * Rendering protocol-item boundaries directly is what made a long turn read as
 * an IDE log; hiding the milestones is what made it read as silence. The
 * milestones and the commentary interleave in turn order, and the execution
 * trail stays collapsed.
 */
export type TurnMilestone = {
  key: string;
  parts: AnyToolPart[];
};

export type TurnPresentation = {
  workItems: UIMessageWithIndex[];
  /** Visible rows in turn order: commentary prose and aggregated tool milestones. */
  visible: Array<
    | { kind: "commentary"; key: string; item: UIMessageWithIndex }
    | { kind: "milestone"; key: string; milestone: TurnMilestone }
  >;
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

  const workItems: UIMessageWithIndex[] = [];
  const answerItems: UIMessageWithIndex[] = [];
  const visible: TurnPresentation["visible"] = [];
  let run: TurnMilestone | null = null;

  const flush = () => {
    if (!run) return;
    visible.push({ kind: "milestone", key: `milestone-${run.key}`, milestone: run });
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
      visible.push({ kind: "commentary", key: `commentary-${item.message.id}`, item });
      return;
    }
    const aggregateParts = aggregatePartsFor(item, showThinking);
    if (aggregateParts.length > 0) {
      if (!run) run = { key: item.message.id, parts: [] };
      run.parts.push(...aggregateParts);
      return;
    }
    // Individual tool detail and reasoning: the collapsed execution trail.
    workItems.push(item);
  });
  flush();

  return { workItems, visible, answerItems };
}
