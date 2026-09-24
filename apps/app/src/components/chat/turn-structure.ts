import type { UIMessage } from "ai";

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

/** Explicit phases win. Older providers use the trailing prose as the answer;
 * a tool after prose means that prose was progress, not a final answer. */
export function turnAnswerIndex(messages: UIMessage[]): number {
  const final = messages.findIndex((message) => messagePhase(message) === "final_answer" && message.parts.some((part) => part.type === "text" && part.text.trim()));
  if (final >= 0) return final;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!message.parts.length) continue;
    if (messagePhase(message) === "commentary") return -1;
    const last = message.parts.findLast((part) => part.type !== "step-start" && !(part.type === "text" && !part.text.trim()));
    if (!last) continue;
    return last.type === "text" ? index : -1;
  }
  return -1;
}
