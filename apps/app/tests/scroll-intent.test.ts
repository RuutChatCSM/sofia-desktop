import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  BOTTOM_THRESHOLD_PX,
  detach,
  followTail,
  intentFromGesture,
  intentFromKey,
  intentFromNavigation,
  intentFromUserScroll,
  isAtTail,
  isFollowing,
  shouldCountHiddenUpdate,
  shouldFollowContentGrowth,
  shouldRepinAfterViewportResize,
  shouldShowJumpToLatest,
  type ScrollGeometry,
} from "../src/react-app/domains/session/surface/scroll-intent";
import {
  selectSessionHiddenUpdates,
  selectSessionIsFollowing,
  selectSessionTailVisible,
  useSessionScrollStore,
  useSessionTailStore,
} from "../src/react-app/domains/session/surface/scroll-store";

/** A 2000px transcript scrolled to the very bottom of a 520px viewport. */
function atTail(): ScrollGeometry {
  return { scrollHeight: 2000, scrollTop: 1480, clientHeight: 520 };
}

/** The same transcript, scrolled up so only the middle is on screen. */
function browsing(): ScrollGeometry {
  return { scrollHeight: 2000, scrollTop: 240, clientHeight: 520 };
}

describe("intent is authoritative, geometry only corroborates", () => {
  test("1. streaming while following never shows the affordance", () => {
    // 50 chunks arrive: content keeps growing, so the tail is technically out
    // of view between paints. Intent says we are following, so nothing shows.
    expect(shouldFollowContentGrowth(isFollowing(followTail()))).toBe(true);
    expect(shouldShowJumpToLatest({ following: true, tailVisible: false })).toBe(false);
    // ...and once the pin lands, the tail is visible again.
    expect(shouldShowJumpToLatest({ following: true, tailVisible: true })).toBe(false);
  });

  test("2. an upward gesture detaches even while still within the threshold", () => {
    // 20px up: geometry would still say "at bottom"...
    const justNudged = { scrollHeight: 2000, scrollTop: 1460, clientHeight: 520 };
    expect(isAtTail(justNudged)).toBe(true);

    // ...but the user said what they want, so geometry gets no vote.
    expect(intentFromGesture({ type: "wheel", direction: "up" }, atTail())).toEqual({
      mode: "detached",
      reason: "user-scroll",
    });
    expect(intentFromGesture({ type: "touch", direction: "up" }, atTail())?.mode).toBe("detached");

    const detached = intentFromGesture({ type: "wheel", direction: "up" }, justNudged)!;
    // New content must not move a detached viewport.
    expect(shouldFollowContentGrowth(isFollowing(detached))).toBe(false);
    expect(shouldShowJumpToLatest({ following: isFollowing(detached), tailVisible: false })).toBe(true);
  });

  test("3. clicking jump-to-latest restores following for good", () => {
    // The click is a state change, not just a scroll: intent flips to following
    // before any of the later 20 chunks arrive.
    const afterClick = followTail();
    expect(shouldFollowContentGrowth(isFollowing(afterClick))).toBe(true);
    expect(shouldShowJumpToLatest({ following: isFollowing(afterClick), tailVisible: false })).toBe(false);
  });

  test("4. a composer or work-block resize re-pins only while following", () => {
    expect(shouldRepinAfterViewportResize(isFollowing(followTail()))).toBe(true);
    expect(shouldRepinAfterViewportResize(isFollowing(detach("user-scroll")))).toBe(false);
  });

  test("5. late content growth behaves like any other growth", () => {
    // A 400px image finishing above the tail pins while following...
    expect(shouldFollowContentGrowth(true)).toBe(true);
    expect(shouldRepinAfterViewportResize(true)).toBe(true);
    // ...and never moves a detached viewport.
    expect(shouldFollowContentGrowth(false)).toBe(false);
    expect(shouldRepinAfterViewportResize(false)).toBe(false);
  });

  test("6. search/navigation detaches, and the affordance brings you back", () => {
    const navigated = intentFromNavigation();
    expect(navigated).toEqual({ mode: "detached", reason: "navigation" });
    expect(shouldShowJumpToLatest({ following: isFollowing(navigated), tailVisible: false })).toBe(true);
    expect(shouldShowJumpToLatest({ following: isFollowing(followTail()), tailVisible: false })).toBe(false);
  });
});

describe("how intent is derived", () => {
  test("scrolling down is validated against the geometry", () => {
    expect(intentFromGesture({ type: "wheel", direction: "down" }, atTail())?.mode).toBe("follow-tail");
    expect(intentFromGesture({ type: "wheel", direction: "down" }, browsing())?.mode).toBe("detached");
    expect(intentFromUserScroll(atTail()).mode).toBe("follow-tail");
    expect(intentFromUserScroll(browsing())).toEqual({ mode: "detached", reason: "user-scroll" });
  });

  test("a pointer press alone is not intent", () => {
    expect(intentFromGesture({ type: "pointer" }, browsing())).toBeNull();
  });

  test("keyboard navigation follows the same rules", () => {
    expect(intentFromKey("PageUp", atTail())?.mode).toBe("detached");
    expect(intentFromKey("Home", atTail())?.mode).toBe("detached");
    expect(intentFromKey("ArrowUp", atTail())?.mode).toBe("detached");
    expect(intentFromKey("End", atTail())?.mode).toBe("follow-tail");
    expect(intentFromKey("PageDown", browsing())?.mode).toBe("detached");
    expect(intentFromKey("a", atTail())).toBeNull();
  });

  test("the threshold is a corroboration band, not a state", () => {
    expect(isAtTail({ scrollHeight: 2000, scrollTop: 1456, clientHeight: 520 })).toBe(true);
    expect(isAtTail({ scrollHeight: 2000, scrollTop: 1455, clientHeight: 520 })).toBe(false);
    expect(BOTTOM_THRESHOLD_PX).toBe(24);
  });

  test("hidden updates are only counted when the user cannot see the tail", () => {
    expect(shouldCountHiddenUpdate({ following: false, tailVisible: false })).toBe(true);
    expect(shouldCountHiddenUpdate({ following: false, tailVisible: true })).toBe(false);
    expect(shouldCountHiddenUpdate({ following: true, tailVisible: false })).toBe(false);
  });
});

describe("the stores expose intent and tail facts separately", () => {
  test("follow state comes from the scroll store, not from geometry", () => {
    const { setStickyBottom, setManualScroll } = useSessionScrollStore.getState();
    setStickyBottom("s1", null);
    expect(selectSessionIsFollowing(useSessionScrollStore.getState().sessions, "s1")).toBe(true);
    setManualScroll("s1", 120, null);
    expect(selectSessionIsFollowing(useSessionScrollStore.getState().sessions, "s1")).toBe(false);
    // An unknown session defaults to following.
    expect(selectSessionIsFollowing(useSessionScrollStore.getState().sessions, "unknown")).toBe(true);
  });

  test("the tail is assumed visible until the observer says otherwise", () => {
    const { setTailVisible, noteHiddenUpdate, clearHiddenUpdates } = useSessionTailStore.getState();
    expect(selectSessionTailVisible(useSessionTailStore.getState().bySession, "s2")).toBe(true);

    setTailVisible("s2", false);
    expect(selectSessionTailVisible(useSessionTailStore.getState().bySession, "s2")).toBe(false);

    expect(selectSessionHiddenUpdates(useSessionTailStore.getState().bySession, "s2")).toBe(0);
    noteHiddenUpdate("s2");
    noteHiddenUpdate("s2");
    expect(selectSessionHiddenUpdates(useSessionTailStore.getState().bySession, "s2")).toBe(2);
    clearHiddenUpdates("s2");
    expect(selectSessionHiddenUpdates(useSessionTailStore.getState().bySession, "s2")).toBe(0);
  });
});

describe("the controller and overlay are wired to intent", () => {
  const read = (relative: string) =>
    readFileSync(new URL(`../src/react-app/domains/session/surface/${relative}`, import.meta.url).pathname, "utf8");

  test("the transcript observes a tail sentinel instead of measuring distance", () => {
    const controller = read("scroll-controller.ts");
    expect(controller).toContain("IntersectionObserver");
    expect(controller).toContain("tailSentinelRef");
    // Our own scrolls can never be read as user intent.
    expect(controller).toContain("programmaticScrollUntilRef");
    expect(controller).toContain("intentFromUserScroll");
    expect(controller).toContain("intentFromNavigation");
    // The old pure-geometry classifier is gone.
    expect(controller).not.toContain("function isAtBottom(");
  });

  test("the overlay shows the affordance from intent plus tail visibility", () => {
    const overlay = read("scroll-overlay.tsx");
    expect(overlay).toContain("shouldShowJumpToLatest");
    expect(overlay).not.toContain("showJumpToLatest = !isAtBottom");
  });

  test("the surface renders the sentinel and wires gestures and keys", () => {
    const surface = readFileSync(
      new URL("../src/react-app/domains/session/surface/session-surface.tsx", import.meta.url).pathname,
      "utf8",
    );
    expect(surface).toContain("data-tail-sentinel");
    expect(surface).toContain("onKeyDown={sessionScroll.handleKeyDown}");
    expect(surface).toContain('type: "wheel", direction:');
    expect(surface).toContain('type: "touch", direction:');
    expect(surface).toContain("sessionScroll.markNavigatedAway()");
  });
});
