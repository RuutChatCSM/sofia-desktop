/**
 * Text of a message part, read defensively.
 *
 * The `ai` types promise `text: string`, but the engine emits text and
 * reasoning parts with no text at all — an interrupted turn is the common case,
 * and a snapshot can arrive before its first delta. Reading `.trim()` or
 * `.length` off that value throws, and React 19 answers an uncaught render
 * error by unmounting the whole app, so every read goes through here.
 */
export function partText(part: { text?: unknown }): string {
  return typeof part.text === "string" ? part.text : "";
}
