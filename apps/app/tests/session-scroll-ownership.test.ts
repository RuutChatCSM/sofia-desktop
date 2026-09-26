import { describe, expect, test } from "bun:test";
import { readFileSync, existsSync } from "node:fs";

import {
  shouldFollowContentGrowth,
  shouldRepinAfterViewportResize,
} from "../src/react-app/domains/session/surface/scroll-intent";

const messageListPath = new URL("../src/components/chat/message-list.tsx", import.meta.url).pathname;
const sessionSurfacePath = new URL(
  "../src/react-app/domains/session/surface/session-surface.tsx",
  import.meta.url,
).pathname;

describe("one vertical scroll owner", () => {
  test("the transcript owns scrolling; live steps do not", () => {
    const source = readFileSync(messageListPath, "utf8");
    const liveSteps = source.slice(source.indexOf('data-live-steps=""') - 200, source.indexOf('data-live-steps=""') + 200);

    expect(liveSteps).not.toContain("overflow-y-auto");
    expect(liveSteps).not.toContain("max-h-[280px]");
    expect(source).not.toContain("max-h-[280px]");
    expect(source).not.toContain("shouldFollowLiveStepGrowth");
    expect(source).not.toContain("node.scrollTop = node.scrollHeight");
  });

  test("the height-capped inner scroller cannot come back", () => {
    expect(existsSync(new URL("../src/components/chat/live-step-scroll.ts", import.meta.url).pathname)).toBe(false);
  });

  test("the session transcript is the scrolling region", () => {
    const source = readFileSync(sessionSurfacePath, "utf8");
    const scrollers = source.match(/overflow-y-auto/g) ?? [];
    expect(scrollers).toHaveLength(1);
  });
});

describe("the jump-to-latest affordance", () => {
  test("is a compact round control, not another textual pill", () => {
    const source = readFileSync(
      new URL("../src/react-app/domains/session/surface/scroll-overlay.tsx", import.meta.url).pathname,
      "utf8",
    );

    expect(source).toContain("data-jump-to-latest");
    expect(source).toContain("ArrowDown");
    expect(source).toContain('aria-label="Jump to latest"');
    expect(source).not.toMatch(/>\s*Jump to latest\s*<\/button>/);
  });
});

describe("resize handling follows intent, not geometry", () => {
  test("a following transcript re-pins; a detached one is left alone", () => {
    expect(shouldRepinAfterViewportResize(true)).toBe(true);
    expect(shouldRepinAfterViewportResize(false)).toBe(false);
    expect(shouldFollowContentGrowth(true)).toBe(true);
    expect(shouldFollowContentGrowth(false)).toBe(false);
  });
});
