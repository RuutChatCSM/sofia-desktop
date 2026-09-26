/**
 * Scroll intent, not scroll geometry.
 *
 * "Am I near the bottom?" and "does the user want to follow the newest
 * content?" are different questions, and conflating them is what made
 * "Jump to latest" flicker. Content growth, a composer resize, a work block
 * changing height, an Activity title change and a late-loading image all move
 * the geometry without the user ever leaving the tail, so geometry must never
 * detach follow mode — only a real user gesture (or an explicit navigation)
 * may. Once detached, geometry stops mattering entirely: new content never
 * moves the user's viewport.
 */
export type ScrollIntentReason = "user-scroll" | "navigation";

export type ScrollIntent =
  | { mode: "follow-tail" }
  | { mode: "detached"; reason: ScrollIntentReason };

export type ScrollGeometry = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
};

/**
 * `direction: "up"` means the user is moving toward *older* content — away from
 * the tail. Callers translate their own convention into this one (a wheel-up
 * and a finger-drag-down both mean "up" here), so the policy never guesses.
 */
export type ScrollGesture =
  | { type: "wheel"; direction: "up" | "down" }
  | { type: "touch"; direction: "up" | "down" }
  | { type: "pointer" };

/** How close to the bottom still counts as "the user came back to the tail". */
export const BOTTOM_THRESHOLD_PX = 24;

/** Keys that always mean "I am going back to look at something above". */
export const DETACH_KEYS = ["PageUp", "Home", "ArrowUp"];
/** Keys that mean "I want to get to the end again". */
export const FOLLOW_KEYS = ["PageDown", "End", "ArrowDown"];

export function scrollBottomGap(geometry: ScrollGeometry): number {
  return geometry.scrollHeight - (geometry.scrollTop + geometry.clientHeight);
}

export function isAtTail(geometry: ScrollGeometry, thresholdPx = BOTTOM_THRESHOLD_PX): boolean {
  return scrollBottomGap(geometry) <= thresholdPx;
}

export function followTail(): ScrollIntent {
  return { mode: "follow-tail" };
}

export function detach(reason: ScrollIntentReason): ScrollIntent {
  return { mode: "detached", reason };
}

export function isFollowing(intent: ScrollIntent): boolean {
  return intent.mode === "follow-tail";
}

/**
 * Geometry *validates* a user's scroll — it never defines intent on its own.
 * Only call this for a scroll the user performed.
 */
export function intentFromUserScroll(
  geometry: ScrollGeometry,
  thresholdPx = BOTTOM_THRESHOLD_PX,
): ScrollIntent {
  return isAtTail(geometry, thresholdPx) ? followTail() : detach("user-scroll");
}

/**
 * An explicit upward gesture detaches even while the geometry still reads as
 * "at the bottom": the user has said what they want, so geometry gets no vote.
 * A downward gesture is validated against the geometry instead.
 */
export function intentFromGesture(
  gesture: ScrollGesture,
  geometry: ScrollGeometry,
  thresholdPx = BOTTOM_THRESHOLD_PX,
): ScrollIntent | null {
  if (gesture.type === "pointer") return null;
  if (gesture.direction === "up") return detach("user-scroll");
  return intentFromUserScroll(geometry, thresholdPx);
}

export function intentFromKey(
  key: string,
  geometry: ScrollGeometry,
  thresholdPx = BOTTOM_THRESHOLD_PX,
): ScrollIntent | null {
  if (DETACH_KEYS.includes(key)) return detach("user-scroll");
  if (FOLLOW_KEYS.includes(key)) return intentFromUserScroll(geometry, thresholdPx);
  return null;
}

/**
 * Sofia moved the user itself — search results, jump-to-start-of-message,
 * a historical anchor. Not a user scroll, but it detaches for the same reason.
 */
export function intentFromNavigation(): ScrollIntent {
  return detach("navigation");
}

/** New content only ever pins the viewport while the user is following. */
export function shouldFollowContentGrowth(following: boolean): boolean {
  return following;
}

/** A composer/work-block resize re-pins only while the user is following. */
export function shouldRepinAfterViewportResize(following: boolean): boolean {
  return following;
}

/**
 * The affordance is about hidden content, not about distance: show it only when
 * the user is detached *and* the tail is genuinely out of view.
 */
export function shouldShowJumpToLatest(input: { following: boolean; tailVisible: boolean }): boolean {
  return !input.following && !input.tailVisible;
}

/** Growth the user cannot see — the "↓ 3" material. */
export function shouldCountHiddenUpdate(input: { following: boolean; tailVisible: boolean }): boolean {
  return shouldShowJumpToLatest(input);
}
