const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Split streaming markdown into top-level blocks at blank lines outside code
 * fences. Finished blocks keep identical text from frame to frame, so a
 * memoized renderer re-parses only the block still being written instead of
 * the whole message on every delta.
 *
 * Continuation lines that start with whitespace stay with the block above
 * (list items, indented code), so a split never cuts through them.
 */
export function splitMarkdownBlocks(text: string): string[] {
  const lines = text.split("\n");
  const blocks: string[] = [];
  let current: string[] = [];
  let fence: string | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const marker = FENCE.exec(line)?.[1];
    if (marker) {
      if (fence === null) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
    }
    const next = lines[index + 1];
    const boundary = fence === null && line.trim() === "" && next !== undefined && next.trim() !== "" && !/^\s/.test(next);
    current.push(line);
    if (boundary) {
      blocks.push(current.join("\n"));
      current = [];
    }
  }
  blocks.push(current.join("\n"));
  return blocks.filter((block, index) => block.trim() !== "" || index === blocks.length - 1);
}
