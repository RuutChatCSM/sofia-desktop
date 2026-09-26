/** @jsxImportSource react */
import { Info, TriangleAlert, X } from "lucide-react";

import { cn } from "@/lib/utils";
import type { SessionNotice as SessionNoticeModel } from "@/lib/session-warning";

/**
 * Session-level notice rendered above the transcript. Carries engine warnings
 * and states the user would otherwise only see as an empty pane — a task held
 * by another Sofia process, or a transcript that could not be loaded.
 *
 * Two registers, and the difference matters: an advisory about the conversation
 * itself is informational (`info`) — muted surface, small type, no accent, one
 * quiet action — while something genuinely degraded (`warning`) takes the amber
 * treatment. An advisory that looks like an incident trains the user to ignore
 * both.
 */
export function SessionNotice({
  notice,
  onDismiss,
  onStartNewChat,
}: {
  notice: SessionNoticeModel;
  onDismiss?: () => void;
  onStartNewChat?: () => void;
}) {
  const informational = notice.kind === "info";
  const action = notice.action === "new-chat" && onStartNewChat ? onStartNewChat : undefined;

  return (
    <div
      role="status"
      data-session-notice
      data-notice-kind={notice.kind}
      className="mx-auto mt-3 w-full max-w-[800px] px-5"
    >
      <div
        className={cn(
          "flex items-center gap-2.5 rounded-xl border px-3 py-1.5 text-[11px] leading-5",
          informational
            ? "border-dls-border bg-dls-hover/50 text-dls-secondary"
            : "border-amber-7/40 bg-amber-2/40 text-amber-11",
        )}
      >
        {informational ? (
          <Info aria-hidden="true" className="size-3.5 shrink-0 text-dls-secondary/70" />
        ) : (
          <TriangleAlert aria-hidden="true" className="size-3.5 shrink-0" />
        )}
        <span className="min-w-0 flex-1">{notice.message}</span>
        {action ? (
          <button
            type="button"
            data-notice-action="new-chat"
            onClick={action}
            className={cn(
              "shrink-0 rounded-md px-2 py-0.5 text-[11px] transition-colors",
              informational
                ? "text-dls-text hover:bg-dls-active"
                : "text-amber-11 hover:bg-amber-3/60",
            )}
          >
            Start new chat
          </button>
        ) : null}
        {onDismiss ? (
          <button
            type="button"
            data-notice-dismiss
            aria-label="Dismiss"
            onClick={onDismiss}
            className={cn(
              "shrink-0 rounded-md p-0.5 transition-colors",
              informational
                ? "text-dls-secondary/70 hover:bg-dls-active hover:text-dls-text"
                : "text-amber-11/80 hover:bg-amber-3/60 hover:text-amber-11",
            )}
          >
            <X aria-hidden="true" className="size-3.5" />
          </button>
        ) : null}
      </div>
    </div>
  );
}
