import { useCallback, useEffect, useRef, type RefObject, type UIEventHandler } from "react";

import { getSessionScrollState, useSessionScrollStore, type SessionScrollState } from "./scroll-store";

// Scroll policy, modelled on Codex's TUI: finalized history is append-only and
// the live turn renders in place at the bottom. Codex never scrolls the user —
// the terminal owns the scrollback. The web equivalent is a single rule:
//
//   * "sticky bottom" = follow the tail (auto-scroll on growth)
//   * any user scroll away from the bottom detaches immediately, and stays
//     detached until the user scrolls back to the bottom
//
// There is deliberately NO time window and NO gesture bookkeeping: those made
// auto-scroll keep fighting the user mid-stream. Classification is purely by
// scroll position, and only our own smooth "jump to latest" is suppressed.

const BOTTOM_THRESHOLD_PX = 24;
// While a user-initiated smooth scroll is animating, intermediate scroll events
// must not be read as "the user scrolled away".
const SMOOTH_JUMP_SUPPRESS_MS = 500;
const EXACT_BOTTOM_GAP_PX = 1;

function readScrollState(sessionId: string | null): SessionScrollState {
  return getSessionScrollState(useSessionScrollStore.getState().sessions, sessionId);
}

function isStickyBottom(sessionId: string | null) {
  return readScrollState(sessionId).mode === "stickyBottom";
}

type SessionScrollControllerOptions = {
  selectedSessionId: string | null;
  renderedMessages: unknown;
  containerRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
};

function scrollBottomGap(container: HTMLElement) {
  return container.scrollHeight - (container.scrollTop + container.clientHeight);
}

function isAtBottom(container: HTMLElement) {
  return scrollBottomGap(container) <= BOTTOM_THRESHOLD_PX;
}

function isExactlyAtBottom(container: HTMLElement) {
  return scrollBottomGap(container) <= EXACT_BOTTOM_GAP_PX;
}

function messageIdForElement(element: HTMLElement) {
  const id = element.getAttribute("data-message-id")?.trim();
  return id && id.length > 0 ? id : null;
}

function latestMessageElement(container: HTMLElement) {
  const messageEls = container.querySelectorAll("[data-message-id]");
  for (let index = messageEls.length - 1; index >= 0; index -= 1) {
    const element = messageEls.item(index);
    if (element instanceof HTMLElement) return element;
  }
  return null;
}

function messageElementById(container: HTMLElement, messageId: string) {
  const messageEls = container.querySelectorAll("[data-message-id]");
  for (const element of messageEls) {
    if (!(element instanceof HTMLElement)) continue;
    if (messageIdForElement(element) === messageId) return element;
  }
  return null;
}

function latestMessageTopClippedId(container: HTMLElement) {
  const latestMessage = latestMessageElement(container);
  if (!latestMessage) return null;

  const messageId = messageIdForElement(latestMessage);
  if (!messageId) return null;

  const containerRect = container.getBoundingClientRect();
  const latestRect = latestMessage.getBoundingClientRect();
  const lastMessageDoesNotFit = latestRect.height > containerRect.height + 1;
  const startVisible = latestRect.top >= containerRect.top - 1 && latestRect.top <= containerRect.bottom + 1;

  return lastMessageDoesNotFit && !startVisible ? messageId : null;
}

export function useSessionScrollController(options: SessionScrollControllerOptions) {
  const selectedSessionId = options.selectedSessionId;
  const setStickyBottom = useSessionScrollStore((state) => state.setStickyBottom);
  const setManualScroll = useSessionScrollStore((state) => state.setManualScroll);
  const setTopClippedMessageId = useSessionScrollStore((state) => state.setTopClippedMessageId);

  const observedContentHeightRef = useRef(0);
  const previousSessionIdRef = useRef<string | null>(null);
  // Timestamp until which scroll classification is skipped because a
  // user-initiated smooth scroll is still animating.
  const suppressClassifyUntilRef = useRef(0);

  const updateOverflowAnchor = useCallback(() => {
    const container = options.containerRef.current;
    if (!container) return;
    // Disable browser scroll anchoring while following the tail: anchoring can
    // nudge scrollTop on content growth and be misread as a manual scroll.
    container.style.overflowAnchor = isStickyBottom(selectedSessionId) ? "none" : "auto";
  }, [options.containerRef, selectedSessionId]);

  const refreshTopClippedMessage = useCallback(() => {
    const container = options.containerRef.current;
    const nextId = container ? latestMessageTopClippedId(container) : null;
    setTopClippedMessageId(selectedSessionId, nextId);
    return nextId;
  }, [options.containerRef, selectedSessionId, setTopClippedMessageId]);

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = "auto") => {
      const container = options.containerRef.current;
      if (!container) return;

      if (behavior === "smooth") {
        suppressClassifyUntilRef.current = Date.now() + SMOOTH_JUMP_SUPPRESS_MS;
        container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
        return;
      }

      setStickyBottom(selectedSessionId, null);
      container.scrollTop = container.scrollHeight;
      refreshTopClippedMessage();
    },
    [options.containerRef, refreshTopClippedMessage, selectedSessionId, setStickyBottom],
  );

  const handleScroll = useCallback<UIEventHandler<HTMLDivElement>>(
    (event) => {
      const container = event.currentTarget;

      // Our own smooth jump in progress — ignore the intermediate frames.
      if (Date.now() < suppressClassifyUntilRef.current) return;

      const topClippedMessageId = latestMessageTopClippedId(container);

      if (isAtBottom(container)) {
        // Follow the tail (idempotent: the store no-ops when unchanged).
        setStickyBottom(selectedSessionId, topClippedMessageId);
        return;
      }

      // The user moved away from the bottom: detach and stop auto-scrolling
      // until they deliberately come back. No timers, no re-attach.
      setManualScroll(selectedSessionId, container.scrollTop, topClippedMessageId);
    },
    [selectedSessionId, setManualScroll, setStickyBottom],
  );

  // Kept for API compatibility with callers that signal a scroll gesture.
  const markScrollGesture = useCallback((_target?: EventTarget | null) => {
    void _target;
  }, []);

  const jumpToLatest = useCallback(
    (behavior: ScrollBehavior = "smooth") => {
      scrollToBottom(behavior);
    },
    [scrollToBottom],
  );

  const jumpToStartOfMessage = useCallback(
    (behavior: ScrollBehavior = "smooth") => {
      const messageId = readScrollState(selectedSessionId).topClippedMessageId;
      const container = options.containerRef.current;
      if (!messageId || !container) return;

      const target = messageElementById(container, messageId);
      if (!target) return;

      setManualScroll(selectedSessionId, container.scrollTop, messageId);
      target.scrollIntoView({ behavior, block: "start" });
    },
    [options.containerRef, selectedSessionId, setManualScroll],
  );

  useEffect(() => {
    updateOverflowAnchor();
    return useSessionScrollStore.subscribe(updateOverflowAnchor);
  }, [updateOverflowAnchor]);

  // Auto-follow: re-anchor to the bottom only while in sticky-bottom mode. Once
  // the user has scrolled up (manual mode), content growth never moves them.
  useEffect(() => {
    const content = options.contentRef.current;
    if (!content) return;

    observedContentHeightRef.current = content.offsetHeight;
    const observer = new ResizeObserver(() => {
      const nextContent = options.contentRef.current;
      if (!nextContent) return;

      const nextHeight = nextContent.offsetHeight;
      const grew = nextHeight > observedContentHeightRef.current + 1;
      observedContentHeightRef.current = nextHeight;

      if (grew && isStickyBottom(selectedSessionId)) {
        scrollToBottom("auto");
        return;
      }

      refreshTopClippedMessage();
    });

    observer.observe(content);
    return () => observer.disconnect();
  }, [options.contentRef, refreshTopClippedMessage, scrollToBottom, selectedSessionId]);

  // Session switch: restore the user's own position for a manual session, or
  // jump to the tail for a fresh/sticky one.
  useEffect(() => {
    if (selectedSessionId === previousSessionIdRef.current) return;
    previousSessionIdRef.current = selectedSessionId;
    if (!selectedSessionId) return;

    observedContentHeightRef.current = 0;
    queueMicrotask(() => {
      const container = options.containerRef.current;
      if (!container) return;

      const savedState = getSessionScrollState(useSessionScrollStore.getState().sessions, selectedSessionId);
      if (savedState.mode === "manual") {
        const top = Math.min(savedState.scrollTop, Math.max(0, container.scrollHeight - container.clientHeight));
        container.scrollTop = top;
        return;
      }

      scrollToBottom("auto");
    });
  }, [options.containerRef, scrollToBottom, selectedSessionId]);

  useEffect(() => {
    void options.renderedMessages;
    queueMicrotask(refreshTopClippedMessage);
  }, [options.renderedMessages, refreshTopClippedMessage]);

  return {
    handleScroll,
    markScrollGesture,
    scrollToBottom,
    jumpToLatest,
    jumpToStartOfMessage,
  };
}
