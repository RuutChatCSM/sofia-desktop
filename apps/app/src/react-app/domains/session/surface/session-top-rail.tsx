/** @jsxImportSource react */
import type { ReactNode } from "react";

import { SessionNotice } from "@/react-app/domains/session/chat/session-notice";

/**
 * The session-level strip, between the session header and the transcript.
 *
 * Keep the three surfaces distinct:
 *
 *   SessionTopRail        things affecting the session itself
 *                         (a task held elsewhere, unreadable transcript,
 *                         later: reconnect / sign-in / approval)
 *   TurnWorkBlock         what Sofia is doing for this turn
 *   Composer `aboveComposer`
 *                         what the user has asked Sofia to do next — the
 *                         queued/steering row belongs there, attached to the
 *                         composer, *not* here
 *
 * It renders nothing when there is nothing session-level to say.
 */
export function SessionTopRail({ notice, children }: { notice?: string | null; children?: ReactNode }) {
  const noticeText = notice?.trim();
  if (!noticeText && !children) return null;

  return (
    <div data-session-top-rail className="flex shrink-0 flex-col">
      {noticeText ? <SessionNotice message={noticeText} /> : null}
      {children}
    </div>
  );
}
