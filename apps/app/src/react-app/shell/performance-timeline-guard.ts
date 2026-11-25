/**
 * React 19.2's development build records a `performance.measure` User Timing
 * entry for every rendered component on every commit, and nothing clears them.
 * A streaming session commits often enough to retain millions of entries,
 * growing the renderer heap into the V8 limit until Chromium aborts the
 * process (`render-process-gone`, reason "crashed").
 *
 * Production builds do not emit these entries. In dev we keep a bounded
 * rolling window of User Timing entries so DevTools performance tracks remain
 * useful without letting the renderer drift toward its heap limit.
 *
 * Operators who need the full timeline for a manual profile can opt out with
 * `localStorage.setItem("sofia.debug.keepPerformanceMeasures", "1")`; that
 * restores the previous (crash-prone) behavior.
 */

export const MAX_RETAINED_MEASURES = 100_000;
export const TRIM_INTERVAL_MS = 10_000;

export const PERFORMANCE_MEASURES_OPT_OUT_KEY = "sofia.debug.keepPerformanceMeasures";

type PerformanceTimeline = Pick<Performance, "getEntriesByType" | "clearMeasures">;

type GuardOptions = {
  performance?: PerformanceTimeline;
  intervalMs?: number;
};

let activeHandle: ReturnType<typeof setInterval> | null = null;

/**
 * Clear the User Timing buffer when it grows past `maxMeasures`. Returns the
 * number of entries dropped (0 when the buffer is within budget).
 */
export function trimPerformanceMeasures(
  timeline: PerformanceTimeline,
  maxMeasures = MAX_RETAINED_MEASURES,
): number {
  let entries: PerformanceEntry[];
  try {
    entries = timeline.getEntriesByType("measure");
  } catch {
    return 0;
  }
  if (entries.length <= maxMeasures) return 0;
  try {
    timeline.clearMeasures();
  } catch {
    return 0;
  }
  return entries.length;
}

function guardEnabled(): boolean {
  if (typeof window === "undefined") return false;
  const env = (import.meta as unknown as { env?: Record<string, unknown> }).env ?? {};
  if (env.PROD === true) return false;
  try {
    return window.localStorage.getItem(PERFORMANCE_MEASURES_OPT_OUT_KEY) !== "1";
  } catch {
    return true;
  }
}

/** Start the dev-only timeline guard. Returns a disposer; safe to call twice. */
export function startPerformanceTimelineGuard(options: GuardOptions = {}): () => void {
  if (!guardEnabled()) return () => {};
  if (activeHandle !== null) return stopPerformanceTimelineGuard;

  const timeline = options.performance ?? performance;
  const intervalMs = options.intervalMs ?? TRIM_INTERVAL_MS;
  activeHandle = setInterval(() => {
    trimPerformanceMeasures(timeline);
  }, intervalMs);
  return stopPerformanceTimelineGuard;
}

export function stopPerformanceTimelineGuard(): void {
  if (activeHandle === null) return;
  clearInterval(activeHandle);
  activeHandle = null;
}
