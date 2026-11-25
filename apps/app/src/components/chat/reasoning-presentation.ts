/**
 * Pure presentation rules for the thinking block, kept out of the component so
 * the header copy and the "show more" cap are testable without rendering.
 */

/** Settled reasoning longer than this folds behind "Show more" inside the block. */
export const REASONING_PREVIEW_CHARS = 1600
export const REASONING_PREVIEW_LINES = 14

export function isLongReasoning(text: string): boolean {
  if (text.length > REASONING_PREVIEW_CHARS) return true
  let lines = 1
  for (const char of text) {
    if (char === "\n" && ++lines > REASONING_PREVIEW_LINES) return true
  }
  return false
}

/** Whole seconds read calmer than "Thought for 0.4s"; anything shorter is 1s. */
export function formatThoughtDuration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

/**
 * "Thinking…" while live, "Thought for 12s" once settled. A phase restored from
 * history was never seen running, so it gets no duration rather than a made-up one.
 */
export function reasoningLabel(input: { isStreaming: boolean; durationMs: number | null }): string {
  if (input.isStreaming) return "Thinking…"
  return input.durationMs === null ? "Thought" : `Thought for ${formatThoughtDuration(input.durationMs)}`
}

/**
 * Client-side timing, like tool calls: reasoning parts carry no timestamps, so
 * a phase is timed from when it is first seen streaming until it stops. A phase
 * is several packets, and it can read as settled for a moment between two of
 * them, so resuming clears the end instead of the first pause freezing it.
 * Held at module scope so remounting the row (session switch) keeps it.
 */
export function createReasoningClock() {
  const timing = new Map<string, { start: number; end: number | null }>()
  return (key: string, isStreaming: boolean, now: number): number | null => {
    const current = timing.get(key)
    if (isStreaming) {
      if (!current) timing.set(key, { start: now, end: null })
      else current.end = null
      return null
    }
    if (!current) return null
    current.end ??= now
    return current.end - current.start
  }
}

export const trackReasoningDuration = createReasoningClock()
