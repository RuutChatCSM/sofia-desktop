import { ArrowDown } from "lucide-react";
import { memo, useCallback } from "react";

import { shouldShowJumpToLatest } from "./scroll-intent";
import {
  selectSessionIsFollowing,
  selectSessionTailVisible,
  selectSessionTopClippedMessageId,
  useSessionScrollStore,
  useSessionTailStore,
} from "./scroll-store";

function useSessionScrollOverlayState(sessionId: string) {
  const following = useSessionScrollStore((state) => selectSessionIsFollowing(state.sessions, sessionId));
  const topClippedMessageId = useSessionScrollStore((state) => selectSessionTopClippedMessageId(state.sessions, sessionId));
  const tailVisible = useSessionTailStore((state) => selectSessionTailVisible(state.bySession, sessionId));

  return { following, topClippedMessageId, tailVisible };
}

type JumpToStartButtonProps = {
  onJumpToStartOfMessage: (behavior?: ScrollBehavior) => void;
};

const JumpToStartButton = memo(function JumpToStartButton({
  onJumpToStartOfMessage,
}: JumpToStartButtonProps) {
  const handleClick = useCallback(() => {
    onJumpToStartOfMessage("smooth");
  }, [onJumpToStartOfMessage]);

  return (
    <button
      type="button"
      className="rounded-full px-3 py-1.5 text-xs text-dls-text transition-colors hover:bg-dls-hover"
      onClick={handleClick}
    >
      Jump to start
    </button>
  );
});

type JumpToLatestButtonProps = {
  onJumpToLatest: (behavior?: ScrollBehavior) => void;
};

const JumpToLatestButton = memo(function JumpToLatestButton({
  onJumpToLatest,
}: JumpToLatestButtonProps) {
  const handleClick = useCallback(() => {
    onJumpToLatest("smooth");
  }, [onJumpToLatest]);

  return (
    // A compact round affordance: a textual pill competes with everything else
    // in the transcript for horizontal attention. The label lives in the
    // tooltip/aria-label.
    <button
      type="button"
      title="Jump to latest"
      aria-label="Jump to latest"
      data-jump-to-latest
      className="flex size-8 items-center justify-center rounded-full border border-dls-border bg-dls-canvas/95 text-dls-text shadow-(--dls-card-shadow) backdrop-blur-md transition-colors hover:bg-dls-hover"
      onClick={handleClick}
    >
      <ArrowDown className="size-4" aria-hidden="true" />
    </button>
  );
});

type SessionScrollOverlayProps = {
  sessionId: string;
  isStreaming: boolean;
  onJumpToLatest: (behavior?: ScrollBehavior) => void;
  onJumpToStartOfMessage: (behavior?: ScrollBehavior) => void;
};

export const SessionScrollOverlay = memo(function SessionScrollOverlay({
  sessionId,
  isStreaming,
  onJumpToLatest,
  onJumpToStartOfMessage,
}: SessionScrollOverlayProps) {
  const { following, topClippedMessageId, tailVisible } = useSessionScrollOverlayState(sessionId);
  const showJumpToStart = !isStreaming && Boolean(topClippedMessageId);
  // Intent + real visibility of the tail, never a distance threshold: growth
  // while following must not flash the affordance.
  const showJumpToLatest = shouldShowJumpToLatest({ following, tailVisible });

  if (!showJumpToStart && !showJumpToLatest) {
    return null;
  }

  return (
    <div className="pointer-events-none absolute bottom-2 left-1/2 z-30 flex -translate-x-1/2 justify-center">
      <div className="pointer-events-auto flex items-center gap-1">
        {showJumpToStart ? (
          <div className="rounded-full border border-dls-border bg-dls-canvas/95 p-1 shadow-(--dls-card-shadow) backdrop-blur-md">
            <JumpToStartButton onJumpToStartOfMessage={onJumpToStartOfMessage} />
          </div>
        ) : null}
        {showJumpToLatest ? <JumpToLatestButton onJumpToLatest={onJumpToLatest} /> : null}
      </div>
    </div>
  );
});
