/**
 * Sofia's own narration inside a turn ("I'll map the Traefik surface across
 * the backend, UI and docs…"): the lines a reader skims to follow how the turn
 * got to its answer. Pure, so the digest rules are testable.
 */

const NOTE_MAX_CHARS = 160

/** The first sentence of a commentary message, as plain single-line text. */
export function commentaryNote(text: string): string {
  const plain = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[*_`>#]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
  if (!plain) return ""
  const sentence = /^(.+?[.!?])(?:\s|$)/.exec(plain)?.[1] ?? plain
  return sentence.length > NOTE_MAX_CHARS ? `${sentence.slice(0, NOTE_MAX_CHARS - 1).trimEnd()}…` : sentence
}

/**
 * What a settled turn shows under "Worked for 2m 7s": its last few narration
 * lines, oldest first, without repeats.
 */
export function commentaryDigest(texts: readonly string[], max = 3): string[] {
  const notes: string[] = []
  for (const text of texts) {
    const note = commentaryNote(text)
    if (note && note !== notes.at(-1)) notes.push(note)
  }
  return notes.slice(-max)
}
