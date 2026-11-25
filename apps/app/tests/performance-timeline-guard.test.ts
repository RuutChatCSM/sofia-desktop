import { describe, expect, test } from "bun:test";

import {
  MAX_RETAINED_MEASURES,
  trimPerformanceMeasures,
} from "../src/react-app/shell/performance-timeline-guard";

function timelineWith(count: number) {
  const entries = Array.from(
    { length: count },
    (_, index) => ({ name: `Component${index}`, entryType: "measure" }) as PerformanceEntry,
  );
  const calls = { clearMeasures: 0 };
  const timeline = {
    getEntriesByType: (type: string) => (type === "measure" ? entries.slice() : []),
    clearMeasures: () => {
      calls.clearMeasures += 1;
    },
  };
  return { timeline, calls };
}

describe("performance timeline guard", () => {
  test("keeps the buffer when it is within budget", () => {
    const { timeline, calls } = timelineWith(10);
    expect(trimPerformanceMeasures(timeline)).toBe(0);
    expect(calls.clearMeasures).toBe(0);
  });

  test("clears the buffer when it exceeds the budget", () => {
    const { timeline, calls } = timelineWith(MAX_RETAINED_MEASURES + 1);
    expect(trimPerformanceMeasures(timeline)).toBe(MAX_RETAINED_MEASURES + 1);
    expect(calls.clearMeasures).toBe(1);
  });

  test("supports a custom budget without touching other entry types", () => {
    const { timeline, calls } = timelineWith(25);
    expect(trimPerformanceMeasures(timeline, 20)).toBe(25);
    expect(calls.clearMeasures).toBe(1);
  });

  test("stays quiet when the timeline cannot be read or cleared", () => {
    const unreadable = {
      getEntriesByType: () => {
        throw new Error("unavailable");
      },
      clearMeasures: () => {},
    };
    const uncl = {
      getEntriesByType: () => new Array(MAX_RETAINED_MEASURES + 1),
      clearMeasures: () => {
        throw new Error("unavailable");
      },
    };
    expect(trimPerformanceMeasures(unreadable)).toBe(0);
    expect(trimPerformanceMeasures(uncl)).toBe(0);
  });
});
