import type { AnyToolPart } from "@/lib/tool-aggregate";

import { commentaryNote } from "./turn-commentary";
import { formatTurnWorkDuration } from "./turn-timing";
import type { TurnWorkEntry } from "./turn-presentation";

/**
 * What the live turn header says. Pure, so the copy is testable: the header
 * names the real current step instead of a generic "Working", and a dropped
 * connection reads as such rather than as a stalled spinner.
 */
export type TurnPhase = "thinking" | "writing" | "working"
export type TurnTone = "working" | "thinking" | "warning"

export type LiveTurnStatus = {
  title: string
  tone: TurnTone
  meta: string[]
  /** Sofia's latest narration, shown under the step ("I'll map the…"). */
  note?: string
}

export function liveTurnStatus(input: {
  phase: TurnPhase
  activityLabel: string | null
  connected: boolean
  elapsed: string | null
  steps: number
  failed: number
  note?: string
}): LiveTurnStatus {
  return { ...baseStatus(input), ...(input.note ? { note: input.note } : {}) }
}

/**
 * The live header's data, derived from the exact pieces the transcript already
 * builds (work entries, answer items, tool parts). Used by the in-transcript
 * header and by the floating dock, so the two can never disagree.
 */
export function liveTurnStatusForTurn(input: {
  workItems: readonly TurnWorkEntry[]
  proseCount: number
  toolParts: readonly AnyToolPart[]
  activityLabel: string | null
  connected: boolean
  elapsedMs: number | null
  commentaryText: string | null
}): LiveTurnStatus {
  const lastWork = input.workItems.at(-1)
  return liveTurnStatus({
    phase: lastWork?.kind === "thought" && lastWork.isStreaming ? "thinking" : input.proseCount > 0 ? "writing" : "working",
    activityLabel: input.activityLabel,
    connected: input.connected,
    elapsed: input.elapsedMs !== null && input.elapsedMs >= 1000 ? formatTurnWorkDuration(input.elapsedMs) : null,
    steps: input.toolParts.length,
    failed: input.toolParts.filter((part) => part.state === "output-error").length,
    note: input.commentaryText ? commentaryNote(input.commentaryText) : undefined,
  })
}

function baseStatus(input: {
  phase: TurnPhase
  activityLabel: string | null
  connected: boolean
  elapsed: string | null
  steps: number
  failed: number
}): LiveTurnStatus {
  const meta = [
    ...(input.elapsed ? [input.elapsed] : []),
    ...(input.steps > 0 ? [`${input.steps} ${input.steps === 1 ? "step" : "steps"}`] : []),
    ...(input.failed > 0 ? [`${input.failed} failed`] : []),
  ]
  if (!input.connected) return { title: "Reconnecting to Sofia…", tone: "warning", meta }
  if (input.activityLabel) return { title: input.activityLabel, tone: "working", meta }
  if (input.phase === "thinking") return { title: "Thinking", tone: "thinking", meta }
  if (input.phase === "writing") return { title: "Writing the answer", tone: "working", meta }
  return { title: "Working", tone: "working", meta }
}
