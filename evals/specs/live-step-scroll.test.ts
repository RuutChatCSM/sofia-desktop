import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { test } from "@sofia/testkit";
import {
  isLiveStepAtBottom,
  pinnedAfterUserScroll,
  pinnedAfterWheel,
  shouldFollowLiveStepGrowth,
} from "../../apps/app/src/components/chat/live-step-scroll";

const messageListPath = fileURLToPath(
  new URL("../../apps/app/src/components/chat/message-list.tsx", import.meta.url),
);

test("live thinking stays put when the user scrolls the step list", ({ evidence }) => {
  const overflowingBottom = { scrollHeight: 2_000, scrollTop: 1_480, clientHeight: 520 };
  const nearBottom = { scrollHeight: 2_000, scrollTop: 1_470, clientHeight: 520 };
  const browsing = { scrollHeight: 2_000, scrollTop: 240, clientHeight: 520 };

  expect(isLiveStepAtBottom(overflowingBottom)).toBe(true);
  expect(isLiveStepAtBottom(nearBottom)).toBe(true);
  expect(isLiveStepAtBottom(browsing)).toBe(false);

  expect(shouldFollowLiveStepGrowth({ isLive: true, pinned: true })).toBe(true);
  expect(shouldFollowLiveStepGrowth({ isLive: true, pinned: false })).toBe(false);
  expect(shouldFollowLiveStepGrowth({ isLive: false, pinned: true })).toBe(false);

  expect(pinnedAfterWheel({ deltaY: -40, pinned: true, atBottom: true })).toBe(false);
  expect(pinnedAfterWheel({ deltaY: 40, pinned: true, atBottom: true })).toBe(true);
  expect(pinnedAfterWheel({ deltaY: 40, pinned: false, atBottom: false })).toBe(false);
  expect(pinnedAfterUserScroll(false)).toBe(false);
  expect(pinnedAfterUserScroll(true)).toBe(true);

  const source = readFileSync(messageListPath, "utf8");
  expect(source).toContain("shouldFollowLiveStepGrowth");
  expect(source).toContain("pinnedAfterWheel");
  expect(source).toContain('data-live-steps=""');
  expect(source).toContain('data-scrollable=""');
  expect(source).not.toContain("if (node && isLiveGroup)");

  evidence.recordAssertionEvidence(
    "Scrolling live thinking leaves earlier steps on screen",
    "Wheel-up unpins the height-capped step list, so streaming growth no longer forces scrollTop back to the latest step. Returning to the tail re-pins; finished turns still fold as before.",
    true,
  );
});
