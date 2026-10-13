import { useCallback, useEffect, useLayoutEffect, useRef, type KeyboardEventHandler, type RefObject, type UIEventHandler } from "react";

import {
  intentFromGesture,
  intentFromKey,
  intentFromNavigation,
  intentFromUserScroll,
  isAtTail,
  shouldCountHiddenUpdate,
  shouldFollowContentGrowth,
  shouldRepinAfterViewportResize,
  type ScrollGesture,
  type ScrollGeometry,
  type ScrollIntent,
} from "./scroll-intent";
import {
  getSessionScrollState,
  selectSessionIsFollowing,
  selectSessionTailVisible,
  useSessionScrollStore,
  useSessionTailStore,
  type SessionScrollAnchor,
} from "./scroll-store";

// Scroll policy: intent first, geometry only as corroboration.
//
// "Near the bottom" (geometry) and "wants to follow the newest content"
// (intent) are different questions. Content growth, a composer resize, a work
// block changing height, an Activity title change or a late-loading image all
// move the geometry without the user ever leaving the tail, so only a real user
// gesture — or an explicit navigation — may detach following. Once detached the
// user's viewport is never moved by new content.
//
//   * follow-tail = pin on growth
//   * detached    = preserve the user's position, offer "Jump to latest"
//
// Our own scrolls (pinning, smooth jumps, navigation) are marked so their
// scroll events are never mistaken for user intent.
const SMOOTH_JUMP_SUPPRESS_MS = 500;
// Window during which scroll events are known to be ours, not the user's.
const PROGRAMMATIC_SCROLL_MS = 120;

function readGeometry(container: HTMLElement): ScrollGeometry {
  return {
    scrollTop: container.scrollTop,
    scrollHeight: container.scrollHeight,
    clientHeight: container.clientHeight,
  };
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

function readVisibleAnchor(container: HTMLElement): SessionScrollAnchor | undefined {
  const bounds=container.getBoundingClientRect();
  for(const element of container.querySelectorAll<HTMLElement>("[data-message-id]")) {
    const rect=element.getBoundingClientRect();
    if(rect.bottom > bounds.top && rect.top < bounds.bottom) {
      const messageId=messageIdForElement(element);
      if(messageId)return {messageId,offset:rect.top-bounds.top};
    }
  }
  return undefined;
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

type SessionScrollControllerOptions = {
  selectedSessionId: string | null;
  renderedMessages: unknown;
  isLoading?: boolean;
  containerRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  /** Marker at the very end of the transcript; drives "is the tail in view?". */
  tailSentinelRef: RefObject<HTMLDivElement | null>;
};

export function useSessionScrollController(options: SessionScrollControllerOptions) {
  const selectedSessionId = options.selectedSessionId;
  const setStickyBottom = useSessionScrollStore((state) => state.setStickyBottom);
  const setManualScroll = useSessionScrollStore((state) => state.setManualScroll);
  const setTopClippedMessageId = useSessionScrollStore((state) => state.setTopClippedMessageId);

  useEffect(() => {
    const container = options.containerRef.current;
    if (!container) return;
    let hideTimer: ReturnType<typeof setTimeout> | undefined;
    const reveal = () => {
      container.setAttribute("data-scroll-active", "");
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => container.removeAttribute("data-scroll-active"), 1200);
    };
    const clearHover = () => container.removeAttribute("data-scroll-hover");
    const trackHover = (event: MouseEvent) => {
      const bounds = container.getBoundingClientRect();
      if (event.clientX >= bounds.right - 10 && event.clientX <= bounds.right) container.setAttribute("data-scroll-hover", "");
      else clearHover();
    };
    container.addEventListener("mousemove", trackHover, { passive: true });
    container.addEventListener("mouseleave", clearHover);
    container.addEventListener("scroll", reveal, { passive: true });
    return () => {
      container.removeEventListener("scroll", reveal);
      container.removeEventListener("mousemove", trackHover);
      container.removeEventListener("mouseleave", clearHover);
      clearHover();
      clearTimeout(hideTimer);
      container.removeAttribute("data-scroll-active");
    };
  }, [options.containerRef, selectedSessionId]);

  const observedContentHeightRef = useRef(0);
  const previousSessionIdRef = useRef<string | null>(null);
  const restorePendingRef = useRef(true);
  const scheduledFramesRef = useRef(new Set<number>());
  const scheduledTimersRef = useRef(new Set<number>());
  // Timestamp until which scroll classification is skipped because a
  // user-initiated smooth scroll is still animating.
  const suppressClassifyUntilRef = useRef(0);
  // Timestamp until which scroll events are known to be ours, not the user's.
  const programmaticScrollUntilRef = useRef(0);

  const isFollowing = useCallback(
    () => selectSessionIsFollowing(useSessionScrollStore.getState().sessions, selectedSessionId),
    [selectedSessionId],
  );

  const applyIntent = useCallback(
    (intent: ScrollIntent) => {
      const container = options.containerRef.current;
      if (!container) return;

      const topClippedMessageId = latestMessageTopClippedId(container);
      if (intent.mode === "follow-tail") {
        setStickyBottom(selectedSessionId, topClippedMessageId);
        useSessionTailStore.getState().clearHiddenUpdates(selectedSessionId);
        return;
      }
      // Detached: remember where the user is so a session switch restores it.
      setManualScroll(selectedSessionId, container.scrollTop, topClippedMessageId, readVisibleAnchor(container));
    },
    [options.containerRef, selectedSessionId, setManualScroll, setStickyBottom],
  );

  const updateOverflowAnchor = useCallback(() => {
    const container = options.containerRef.current;
    if (!container) return;
    // Disable browser scroll anchoring while following the tail: anchoring can
    // nudge scrollTop on content growth and be misread as a manual scroll.
    container.style.overflowAnchor = isFollowing() ? "none" : "auto";
  }, [isFollowing, options.containerRef]);

  const refreshTopClippedMessage = useCallback(() => {
    const container = options.containerRef.current;
    const nextId = container ? latestMessageTopClippedId(container) : null;
    setTopClippedMessageId(selectedSessionId, nextId);
    return nextId;
  }, [options.containerRef, selectedSessionId, setTopClippedMessageId]);

  const restoreManualPosition = useCallback(() => {
    const container=options.containerRef.current;
    if(!container)return false;
    const saved=getSessionScrollState(useSessionScrollStore.getState().sessions,selectedSessionId);
    if(saved.mode!=="manual")return false;
    if(options.isLoading || !container.querySelector("[data-message-id]"))return false;
    const target=saved.anchor ? messageElementById(container,saved.anchor.messageId) : null;
    // Keep the saved anchor while a partial/cached transcript is replaced.
    // Clamping against incomplete history would permanently overwrite it.
    if(saved.anchor && !target)return false;
    const top=target && saved.anchor ? container.scrollTop+target.getBoundingClientRect().top-container.getBoundingClientRect().top-saved.anchor.offset : saved.scrollTop;
    programmaticScrollUntilRef.current=Date.now()+PROGRAMMATIC_SCROLL_MS;
    container.scrollTop=Math.max(0,Math.min(top,container.scrollHeight-container.clientHeight));
    setManualScroll(selectedSessionId,container.scrollTop,latestMessageTopClippedId(container),readVisibleAnchor(container));
    restorePendingRef.current=false;
    return true;
  },[options.containerRef,options.isLoading,selectedSessionId,setManualScroll]);

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
      programmaticScrollUntilRef.current = Date.now() + PROGRAMMATIC_SCROLL_MS;
      container.scrollTop = container.scrollHeight;
      refreshTopClippedMessage();
    },
    [options.containerRef, refreshTopClippedMessage, selectedSessionId, setStickyBottom],
  );

  const handleScroll = useCallback<UIEventHandler<HTMLDivElement>>(
    (event) => {
      const container = event.currentTarget;
      if(restorePendingRef.current)return;

      // Our own smooth jump in progress — ignore the intermediate frames.
      if (Date.now() < suppressClassifyUntilRef.current) return;

      // A scroll we caused (pinning, navigation) is never user intent. If it
      // landed on the tail, confirm the follow state; otherwise leave intent
      // exactly as it was.
      if (Date.now() < programmaticScrollUntilRef.current) {
        if (isFollowing() && isAtTail(readGeometry(container))) {
          setStickyBottom(selectedSessionId, latestMessageTopClippedId(container));
        }
        return;
      }

      // Geometry corroborates a user's scroll; it never defines intent alone.
      applyIntent(intentFromUserScroll(readGeometry(container)));
    },
    [applyIntent, isFollowing, selectedSessionId, setStickyBottom],
  );

  const handleKeyDown = useCallback<KeyboardEventHandler<HTMLDivElement>>(
    (event) => {
      const container = options.containerRef.current;
      if (!container || event.defaultPrevented || event.repeat) return;
      const target=event.target;
      if(target instanceof HTMLElement && target!==container && (target.isContentEditable || target.closest("input,select,textarea") || ((event.key===" " || event.key==="Spacebar") && target.closest("button,[role=button]"))))return;
      restorePendingRef.current=false;
      suppressClassifyUntilRef.current=0;programmaticScrollUntilRef.current=0;
      const intent = intentFromKey(event.key, readGeometry(container), undefined, event.shiftKey);
      if (intent) applyIntent(intent);
    },
    [applyIntent, options.containerRef],
  );

  const markScrollGesture = useCallback(
    (gesture: ScrollGesture) => {
      const container = options.containerRef.current;
      if (!container) return;
      restorePendingRef.current=false;
      suppressClassifyUntilRef.current=0;programmaticScrollUntilRef.current=0;
      const intent = intentFromGesture(gesture, readGeometry(container));
      if (intent) applyIntent(intent);
    },
    [applyIntent, options.containerRef],
  );

  /**
   * Sofia moved the user itself (search result, jump to an older message).
   * Same effect as a user scroll away from the tail, recorded as navigation.
   */
  const markNavigatedAway = useCallback(() => {
    applyIntent(intentFromNavigation());
  }, [applyIntent]);

  /**
   * Clicking "Jump to latest" is a state change first and a scroll second: set
   * the intent, then move, then verify on the next frames because React may
   * still be committing the newest work-block/Activity update.
   */
  const jumpToLatest = useCallback(
    (behavior: ScrollBehavior = "smooth") => {
      const container = options.containerRef.current;
      if (!container) return;

      setStickyBottom(selectedSessionId, null);
      useSessionTailStore.getState().clearHiddenUpdates(selectedSessionId);

      const verifyTail = () => {
        const node = options.containerRef.current;
        if (!node) return;
        if (!isFollowing()) return;
        if (isAtTail(readGeometry(node))) {
          refreshTopClippedMessage();
          return;
        }
        // A late layout commit left us short of the new bottom: pin instantly.
        programmaticScrollUntilRef.current = Date.now() + PROGRAMMATIC_SCROLL_MS;
        node.scrollTop = node.scrollHeight;
        refreshTopClippedMessage();
      };

      if (behavior === "smooth") {
        // Let the animation play; verify once it should have finished rather
        // than snapping mid-flight (which makes the easing look broken).
        suppressClassifyUntilRef.current = Date.now() + SMOOTH_JUMP_SUPPRESS_MS;
        container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
        const timer=window.setTimeout(()=>{scheduledTimersRef.current.delete(timer);verifyTail();}, SMOOTH_JUMP_SUPPRESS_MS + 50);
        scheduledTimersRef.current.add(timer);
        return;
      }

      programmaticScrollUntilRef.current = Date.now() + PROGRAMMATIC_SCROLL_MS;
      container.scrollTop = container.scrollHeight;
      const frame=window.requestAnimationFrame(() => {
        scheduledFramesRef.current.delete(frame);verifyTail();
        const next=window.requestAnimationFrame(()=>{scheduledFramesRef.current.delete(next);verifyTail();});
        scheduledFramesRef.current.add(next);
      });
      scheduledFramesRef.current.add(frame);
    },
    [
      isFollowing,
      options.containerRef,
      refreshTopClippedMessage,
      selectedSessionId,
      setStickyBottom,
    ],
  );

  const jumpToStartOfMessage = useCallback(
    (behavior: ScrollBehavior = "smooth") => {
      const messageId = getSessionScrollState(useSessionScrollStore.getState().sessions, selectedSessionId).topClippedMessageId;
      const container = options.containerRef.current;
      if (!messageId || !container) return;

      const target = messageElementById(container, messageId);
      if (!target) return;

      applyIntent(intentFromNavigation());
      programmaticScrollUntilRef.current = Date.now() + PROGRAMMATIC_SCROLL_MS;
      target.scrollIntoView({ behavior, block: "start" });
    },
    [applyIntent, options.containerRef, selectedSessionId],
  );

  useEffect(() => {
    updateOverflowAnchor();
    return useSessionScrollStore.subscribe(updateOverflowAnchor);
  }, [updateOverflowAnchor]);

  // Is the tail actually on screen? This — not a distance threshold — is what
  // decides whether "Jump to latest" is worth showing.
  useEffect(() => {
    const sentinel = options.tailSentinelRef.current;
    const container = options.containerRef.current;
    if (!sentinel || !container || typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1];
        if (!entry) return;
        useSessionTailStore.getState().setTailVisible(selectedSessionId, entry.isIntersecting);
      },
      { root: container, threshold: 0 },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [options.containerRef, options.tailSentinelRef, selectedSessionId]);

  // Content growth: pin only while the user is following. While detached, the
  // viewport is theirs — we just count what they cannot see yet.
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

      if(restorePendingRef.current){restoreManualPosition();return;}
      if(!isFollowing())restoreManualPosition();

      if (grew) {
        if (shouldFollowContentGrowth(isFollowing())) {
          scrollToBottom("auto");
          return;
        }
        const tailVisible = selectSessionTailVisible(useSessionTailStore.getState().bySession, selectedSessionId);
        if (shouldCountHiddenUpdate({ following: false, tailVisible })) {
          useSessionTailStore.getState().noteHiddenUpdate(selectedSessionId);
        }
      }

      refreshTopClippedMessage();
    });

    observer.observe(content);
    return () => observer.disconnect();
  }, [isFollowing, options.contentRef, refreshTopClippedMessage, scrollToBottom, selectedSessionId, restoreManualPosition]);

  // Composer growth (activity status, queued messages, questions, permissions)
  // shrinks the transcript viewport without touching the content, so the content
  // observer above never fires. Re-pin only while following; a detached
  // transcript keeps the user's anchor.
  useEffect(() => {
    const container = options.containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver(() => {
      if(restorePendingRef.current){restoreManualPosition();return;}
      if (!shouldRepinAfterViewportResize(isFollowing())) {restoreManualPosition();return;}
      scrollToBottom("auto");
    });

    observer.observe(container);
    return () => observer.disconnect();
  }, [isFollowing, options.containerRef, scrollToBottom, restoreManualPosition]);

  // Cancel delayed jumps when this surface changes sessions or unmounts.
  useLayoutEffect(()=>()=>{
    for(const timer of scheduledTimersRef.current)window.clearTimeout(timer);
    for(const frame of scheduledFramesRef.current)window.cancelAnimationFrame(frame);
    scheduledTimersRef.current.clear();scheduledFramesRef.current.clear();
  },[selectedSessionId]);

  useLayoutEffect(()=>{
    if(selectedSessionId!==previousSessionIdRef.current){
      previousSessionIdRef.current=selectedSessionId;
      restorePendingRef.current=true;
      suppressClassifyUntilRef.current=0;
      programmaticScrollUntilRef.current=0;
      observedContentHeightRef.current=0;
      useSessionTailStore.getState().clearHiddenUpdates(selectedSessionId);
    }
    if(!selectedSessionId)return;
    if(!isFollowing()){restoreManualPosition();return;}
    if(restorePendingRef.current && !options.isLoading){
      restorePendingRef.current=false;
      scrollToBottom("auto");
    }
  },[selectedSessionId,options.renderedMessages,options.isLoading,isFollowing,restoreManualPosition,scrollToBottom]);

  useEffect(() => {
    void options.renderedMessages;
    queueMicrotask(refreshTopClippedMessage);
  }, [options.renderedMessages, refreshTopClippedMessage]);

  return {
    handleScroll,
    handleKeyDown,
    markScrollGesture,
    markNavigatedAway,
    scrollToBottom,
    jumpToLatest,
    jumpToStartOfMessage,
  };
}
