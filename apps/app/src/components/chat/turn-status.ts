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
