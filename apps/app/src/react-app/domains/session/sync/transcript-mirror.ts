/**
 * Which sessions need their transcript re-serialized.
 *
 * The mirror used to rebuild *every* session's full transcript once per frame,
 * so its cost grew with total history rather than with the change. One long
 * conversation — or a busy session beside a long one — then saturated the main
 * thread and the app froze, including on a single revert, which fans out into a
 * burst of store updates. Zustand replaces the entry object only for sessions
 * that changed, so identity is the whole test.
 */
export function changedSessionIds(
  next: Record<string, unknown>,
  previous: Record<string, unknown>,
): string[] {
  const changed: string[] = [];
  for (const [sessionId, entry] of Object.entries(next)) {
    if (previous[sessionId] !== entry) changed.push(sessionId);
  }
  return changed;
}
