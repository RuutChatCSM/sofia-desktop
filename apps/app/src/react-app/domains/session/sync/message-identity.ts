import type { UIMessage } from "ai";

function samePart(a: UIMessage["parts"][number], b: UIMessage["parts"][number]): boolean {
  if (a === b) return true;
  const aEntries = Object.entries(a);
  if (aEntries.length !== Object.keys(b).length) return false;
  return aEntries.every(([key, value]) => Object.is(value, (b as Record<string, unknown>)[key]));
}

function sameJson(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Reuse the previous message object when a rebuilt one is equivalent.
 *
 * Transcript rebuilds produce fresh user/pending message objects every frame;
 * keeping identity lets memoized rows skip rendering and lets the caller skip
 * the cache write entirely when nothing visible changed. Parts are compared
 * shallowly: nested payloads (tool input/output) come from cached items and
 * are already reference-stable.
 */
export function shareMessageIdentity(previous: readonly UIMessage[] | undefined, next: UIMessage[]): UIMessage[] {
  if (!previous?.length) return next;
  const byId = new Map(previous.map((message) => [message.id, message]));
  let changed = previous.length !== next.length;
  const shared = next.map((message, index) => {
    const prior = byId.get(message.id);
    const reused = prior && prior !== message && prior.role === message.role &&
      prior.parts.length === message.parts.length &&
      prior.parts.every((part, partIndex) => samePart(part, message.parts[partIndex])) &&
      sameJson(prior.metadata, message.metadata)
      ? prior
      : message;
    if (reused !== previous[index]) changed = true;
    return reused;
  });
  return changed ? shared : (previous as UIMessage[]);
}
