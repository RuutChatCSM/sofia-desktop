/** Reorder known history while keeping unrecorded live items at their anchors. */
export function mergeCanonicalItemOrder<T extends { id: string }>(live: readonly T[], canonical: readonly T[]): T[] {
  const known = new Set(canonical.map(item => item.id));
  const before = new Map<string, T[]>();
  const tail: T[] = [];
  let nextKnown: string | undefined;
  for (let i = live.length - 1; i >= 0; i--) {
    const item = live[i];
    if (known.has(item.id)) { nextKnown = item.id; continue; }
    const group = nextKnown ? (before.get(nextKnown) ?? []) : tail;
    group.push(item);
    if (nextKnown) before.set(nextKnown, group);
  }
  return [...canonical.flatMap(item => [...(before.get(item.id) ?? []).reverse(), item]), ...tail.reverse()];
}
