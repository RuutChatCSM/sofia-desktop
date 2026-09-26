import type { UIMessage } from "ai";

import type { AnyToolPart } from "@/lib/tool-aggregate";

import { getAggregateOnlyParts, getAssistantRenderGroups } from "./utils";
import { messagePhase, turnAnswerIndex } from "./turn-structure";

export type UIMessageWithIndex = { index: number; message: UIMessage };

/**
 * How a turn reads in the transcript: one work disclosure, then the answer.
 *
 *   work    everything the turn did, in the order it did it — commentary
 *           (`phase: "commentary"` progress prose), aggregated tool milestones
 *           ("Ran 2 commands"), reasoning summaries, and tool detail
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
  | { kind: "reasoning"; key: string; text: string; isStreaming: boolean }
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

/**
 * The message's own reasoning and whether it has anything else to show.
 *
 * Reasoning is a work entry like any other, not a summary hoisted to the top of
 * the disclosure: a turn that reasoned, ran something, then reasoned again reads
 * in that order, which is the order it happened in.
 */
function detailGroupsFor(item: UIMessageWithIndex, showThinking: boolean) {
  if (item.message.role !== "assistant") return { reasoning: "", hasDetail: false };
  const groups = getAssistantRenderGroups(item.message.parts, showThinking);
  const reasoning = groups
    .filter((group) => group.kind === "reasoning")
    .map((group) => group.text.trim())
    .filter(Boolean)
    .join("\n\n");
  return { reasoning, hasDetail: groups.some((group) => group.kind !== "reasoning") };
}

function reasoningIsStreaming(item: UIMessageWithIndex, showThinking: boolean): boolean {
  if (item.message.role !== "assistant") return false;
  return getAssistantRenderGroups(item.message.parts, showThinking).some(
    (group) => group.kind === "reasoning" && group.isStreaming,
  );
}

/**
 * The work one item contributes, in order: its reasoning, then its detail.
 *
 * Exported because a turn can also arrive as a single assistant message with the
 * steps and the answer interleaved (see `splitTurnAtAnswer`). Splitting that
 * message has to produce the same work entries, or a whole turn's reasoning is
 * silently dropped along with the split.
 */
export function workEntriesForMessage(
  item: UIMessageWithIndex,
  showThinking: boolean,
): TurnWorkEntry[] {
  const { reasoning, hasDetail } = detailGroupsFor(item, showThinking);
  const entries: TurnWorkEntry[] = [];
  if (reasoning) {
    entries.push({
      kind: "reasoning",
      key: `reasoning-${item.message.id}`,
      text: reasoning,
      isStreaming: reasoningIsStreaming(item, showThinking),
    });
  }
  if (hasDetail) entries.push({ kind: "detail", key: `detail-${item.message.id}`, item });
  return entries;
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
  // Reasoning seen *inside* a run of tool events. Emitting it immediately would
  // split one "Ran 2 commands" row into two, so it waits for the run to close and
  // follows it — the aggregate covers the stretch the reasoning happened in.
  let midRunReasoning: TurnWorkEntry[] = [];

  const flush = () => {
    if (run) {
      work.push(run);
      run = null;
    }
    if (midRunReasoning.length) {
      work.push(...midRunReasoning);
      midRunReasoning = [];
    }
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
    const { reasoning, hasDetail } = detailGroupsFor(item, showThinking);
    if (reasoning && !hasDetail && run) {
      midRunReasoning.push({
        kind: "reasoning",
        key: `reasoning-${item.message.id}`,
        text: reasoning,
        isStreaming: reasoningIsStreaming(item, showThinking),
      });
      return;
    }
    // Reasoning and individual tool detail: still part of the same narrative, and
    // in its own place in it — reasoning that preceded a run of tools comes before
    // the tools, not collected into one block at the top.
    flush();
    if (reasoning) {
      work.push({
        kind: "reasoning",
        key: `reasoning-${item.message.id}`,
        text: reasoning,
        isStreaming: reasoningIsStreaming(item, showThinking),
      });
    }
    if (hasDetail) work.push({ kind: "detail", key: `detail-${item.message.id}`, item });
  });
  flush();

  return { work, answerItems };
}
