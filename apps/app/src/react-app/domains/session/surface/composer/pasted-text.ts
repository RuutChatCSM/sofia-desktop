export const FILE_URL_RE = /^file:\/\//i;
export const HTTP_URL_RE = /^https?:\/\//i;

export type PastedTextSegment =
  | { kind: "text"; text: string }
  | { kind: "line-break" }
  | { kind: "tab" };

export type PastedTextChip = {
  id: string;
  label: string;
  text: string;
  lines: number;
  /**
   * Whether this paste may be expanded into the model's text. A collapsed chip
   * solves *UI* density; pastes above the budget solve *context* density by
   * riding as an attachment instead.
   */
  inline: boolean;
};

/**
 * ~16 KB. A chip that still expands into a 500 KB string only hides the bytes
 * from the user, not from the model, so oversized pastes are attached.
 */
export const INLINE_PASTE_BUDGET_BYTES = 16 * 1024;

const UTF8_ENCODER = new TextEncoder();

export function utf8ByteLength(text: string) {
  return UTF8_ENCODER.encode(text).length;
}

export function isInlinePaste(text: string) {
  return utf8ByteLength(text) <= INLINE_PASTE_BUDGET_BYTES;
}

const WHITESPACE_RE = /\s/;

export function isStandaloneHttpUrl(text: string) {
  return HTTP_URL_RE.test(text) && !WHITESPACE_RE.test(text);
}

export function shouldCollapsePastedText(text: string, wouldOverflowComposer: boolean) {
  return wouldOverflowComposer && !isStandaloneHttpUrl(text);
}

export function createPastedTextChip(text: string): PastedTextChip {
  const id = `paste-${Math.random().toString(36).slice(2)}`;
  const lines = text.split(/\r?\n/).length;
  return {
    id,
    label: `${id.slice(-4)} · ${lines} lines`,
    text,
    lines,
    inline: isInlinePaste(text),
  };
}

/** The paste as a plain-text file, so an oversized paste still reaches the model. */
export function createPastedTextFile(chip: Pick<PastedTextChip, "id" | "text">, name?: string): File {
  const filename = name ?? `pasted-text-${chip.id.replace(/^paste-/, "")}.txt`;
  return new File([chip.text], filename, { type: "text/plain" });
}

export function resolvePastedTextPlaceholders(
  text: string,
  pastedText: readonly (Pick<PastedTextChip, "label" | "text"> & { inline?: boolean })[],
) {
  let resolved = text;
  for (const part of pastedText) {
    // A non-inline paste stays a placeholder: the model reads the attachment.
    if (part.inline === false) continue;
    resolved = resolved.replace(`[pasted text ${part.label}]`, part.text);
  }
  return resolved;
}

export function splitPastedText(text: string) {
  const segments: PastedTextSegment[] = [];
  for (const part of text.split(/(\r?\n|\t)/)) {
    if (part === "\n" || part === "\r\n") {
      segments.push({ kind: "line-break" });
    } else if (part === "\t") {
      segments.push({ kind: "tab" });
    } else if (part) {
      segments.push({ kind: "text", text: part });
    }
  }
  return segments;
}
