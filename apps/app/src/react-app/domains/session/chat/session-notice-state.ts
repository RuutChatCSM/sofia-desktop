/**
 * Notices already surfaced, so a repeated one is not re-announced.
 *
 * The engine re-sends the long-thread advisory after every compaction, and the
 * codex store clears a session's warning when the next prompt is sent — so the
 * same advisory arrives again and again. Saying it a second time does not make it
 * truer, so the first surfacing claims the message for the life of the session,
 * and a dismissal therefore sticks.
 *
 * Keyed by session as well as by message: two conversations must never suppress
 * each other's notices.
 */
const surfaced = new Set<string>();

export function noticeSurfacingKey(sessionId: string, message: string): string {
  return `${sessionId}\u0000${message}`;
}

/** True only the first time this message is surfaced for this session. */
export function claimNoticeSurfacing(sessionId: string, message: string): boolean {
  const key = noticeSurfacingKey(sessionId, message);
  if (surfaced.has(key)) return false;
  surfaced.add(key);
  return true;
}

/** Test/teardown hook: forget which notices have been surfaced. */
export function resetSurfacedNotices(): void {
  surfaced.clear();
}
