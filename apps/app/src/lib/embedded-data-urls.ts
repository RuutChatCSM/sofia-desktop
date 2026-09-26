/**
 * Defence in depth at the send boundary: encoded binary must never ride a
 * prompt as text.
 *
 * The clipboard classifier turns images into attachments before the editor sees
 * them, but one missed clipboard path is enough to dump a base64 wall into the
 * context window. So the last thing every send path does is strip embedded
 * `data:…;base64,…` payloads out of the model's text, leaving a short,
 * human-readable note behind where they were.
 */
export const EMBEDDED_IMAGE_PLACEHOLDER =
  "[image data removed — attach the image instead of pasting its bytes]";
export const EMBEDDED_DATA_PLACEHOLDER = "[encoded data removed]";

// Only payloads long enough to be real binary are stripped, so a short data URI
// quoted in a code snippet is left alone. The payload stops before the next
// `data:` so two blobs pasted back to back are stripped as two, not one.
const MIN_BASE64_PAYLOAD = 32;
const EMBEDDED_DATA_URL_RE = new RegExp(
  `data:([a-z0-9.+-]+\\/[a-z0-9.+-]+)?;base64,(?:(?!data:)[a-zA-Z0-9+/=\\s]){${MIN_BASE64_PAYLOAD},}`,
  "gi",
);

export function containsEmbeddedBinary(text: string): boolean {
  EMBEDDED_DATA_URL_RE.lastIndex = 0;
  return EMBEDDED_DATA_URL_RE.test(text);
}

/** Replace embedded base64 with a note. Never returns encoded binary. */
export function stripEmbeddedBinary(text: string): { text: string; removed: number } {
  let removed = 0;
  const next = text.replace(
    EMBEDDED_DATA_URL_RE,
    (_match, mime: string | undefined) => {
      removed += 1;
      return (mime ?? "").startsWith("image/")
        ? EMBEDDED_IMAGE_PLACEHOLDER
        : EMBEDDED_DATA_PLACEHOLDER;
    },
  );
  return { text: next, removed };
}

/**
 * Convenience for send paths. Reaching here with encoded binary means some
 * earlier gate (the clipboard classifier, a paste path) let it through, so it
 * is recorded rather than silently deleted.
 */
export function sanitizePromptText(text: string): string {
  const { text: next, removed } = stripEmbeddedBinary(text);
  if (removed > 0) {
    console.warn(`[prompt] removed ${removed} embedded base64 payload(s) from the model text`);
  }
  return next;
}
