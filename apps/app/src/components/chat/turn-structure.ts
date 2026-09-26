import type { UIMessage } from "ai";

import { partText } from "@/lib/message-part-text";

function engineMetadata(message: UIMessage): Record<string, unknown> | null {
  const metadata = message.metadata;
  if (!metadata || typeof metadata !== "object" || !("engine" in metadata)) return null;
  const engine = metadata.engine;
  if (!engine || typeof engine !== "object" || Array.isArray(engine)) return null;
  return Object.fromEntries(Object.entries(engine));
}

export function messageTurnId(message: UIMessage): string | null {
  const id = engineMetadata(message)?.turnId;
  return typeof id === "string" && id ? id : null;
}

export function messagePhase(message: UIMessage): "commentary" | "final_answer" | null {
  const phase = engineMetadata(message)?.phase;
  return phase === "commentary" || phase === "final_answer" ? phase : null;
}

/**
 * The answer is the turn's *trailing* prose — everything before it is work.
 *
 * This scans from the end, not for the first `final_answer`: a turn can contain
 * an earlier `final_answer` phase followed by more work, because the runtime
 * continued when the goal was not satisfied. Treating that earlier message as
 * the answer is what leaked every later progress narration ("Let me find…",
 * "Now the core change…") into the transcript as standalone prose instead of
 * folding it into the turn's work block.
 *
 * `commentary` is progress narration by definition, so it never answers a turn;
 * when the last content is commentary the turn is still working and there is no
 * answer yet (everything folds into the work).
 */
export function turnAnswerIndex(messages: UIMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message.parts.length) continue;
    const last = message.parts.findLast(
      (part) => part.type !== "step-start" && !(part.type === "text" && !partText(part).trim()),
    );
    if (!last) continue;
    if (messagePhase(message) === "commentary") return -1;
    // Trailing prose is the answer; a tool after prose means that prose was progress.
    return last.type === "text" ? index : -1;
  }
  return -1;
}
