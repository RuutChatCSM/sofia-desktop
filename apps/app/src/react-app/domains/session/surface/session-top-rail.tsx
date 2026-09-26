/** @jsxImportSource react */
import type { ReactNode } from "react";

import type { SessionNotice as SessionNoticeModel } from "@/lib/session-warning";
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
export function SessionTopRail({
  notice,
  onDismiss,
  onStartNewChat,
  children,
}: {
  notice?: SessionNoticeModel | null;
  onDismiss?: () => void;
  onStartNewChat?: () => void;
  children?: ReactNode;
}) {
  // A notice with no text is not a notice; the classifier already drops empties,
  // and this keeps the rail honest for any caller that constructs one directly.
  const shown = notice?.message.trim() ? notice : null;
  if (!shown && !children) return null;

  return (
    <div data-session-top-rail className="flex shrink-0 flex-col">
      {shown ? (
        <SessionNotice notice={shown} onDismiss={onDismiss} onStartNewChat={onStartNewChat} />
      ) : null}
      {children}
    </div>
  );
}
