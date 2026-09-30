import { describe, expect, test } from "bun:test";

import {
  BROWSER_PEEK_HEIGHT,
  BROWSER_PEEK_VIEWPORT,
  BROWSER_PEEK_WIDTH,
  MAX_BROWSER_PEEK_HEIGHT,
  MAX_BROWSER_PEEK_WIDTH,
  MIN_BROWSER_PEEK_HEIGHT,
  MIN_BROWSER_PEEK_WIDTH,
  PERSISTED_BROWSER_PRESENTATION_KEY,
  MAX_BROWSER_EXPANDED_WIDTH,
  MIN_BROWSER_EXPANDED_WIDTH,
  beginPeekDrag,
  browserAttentionHost,
  browserExpandedWidth,
  browserPeekSize,
  browserPeekViewport,
  browserPresentationVisible,
  clampDockedWidth,
  clampPeekPosition,
  createBrowserPresentationState,
  defaultPeekPosition,
  movePeekDrag,
  peekDragPosition,
  reduceBrowserPresentation,
  type BrowserPresentationEvent,
  type BrowserPresentationState,
} from "../src/react-app/domains/session/panel/browser-presentation";

function reduceAll(
  state: BrowserPresentationState,
  events: BrowserPresentationEvent[],
): BrowserPresentationState {
  return events.reduce((current, event) => reduceBrowserPresentation(current, event), state);
}

function state(events: BrowserPresentationEvent[] = []) {
  return reduceAll(createBrowserPresentationState(), events);
}

describe("browser presentation policy", () => {
  test("agent browser activity surfaces Peek without disturbing anything already shown", () => {
    expect(state([{ type: "agent-browser-started" }]).runtime.mode).toBe("peek");

    const docked = state([{ type: "agent-browser-started" }, { type: "user-dock-browser" }]);
    expect(reduceBrowserPresentation(docked, { type: "agent-browser-started" })).toEqual(docked);

    const expanded = reduceBrowserPresentation(docked, { type: "user-expand-browser" });
    expect(reduceBrowserPresentation(expanded, { type: "agent-browser-started" })).toEqual(expanded);
  });

  test("an explicit Hide is sticky for the rest of the task", () => {
    const hidden = state([{ type: "agent-browser-started" }, { type: "user-hide-peek" }]);
    expect(hidden.runtime.mode).toBe("hidden");
    expect(hidden.runtime.peekSuppressed).toBe(true);

    const stillHidden = reduceAll(hidden, [
      { type: "agent-browser-started" },
      { type: "agent-browser-started" },
      { type: "agent-browser-started" },
    ]);
    expect(stillHidden).toEqual(hidden);

    // Opening from the empty state shows the normal split; Peek is reached
    // through its own explicit action, not as a side effect of opening.
    const reopened = reduceBrowserPresentation(stillHidden, { type: "user-open-browser" });
    expect(reopened.runtime.mode).toBe("docked");
    expect(reopened.runtime.peekSuppressed).toBe(false);
  });

  test("autoShow attention and never leave agent activity hidden", () => {
    for (const autoShow of ["attention", "never"] as const) {
      const configured = reduceBrowserPresentation(createBrowserPresentationState(), {
        type: "preference-auto-show",
        value: autoShow,
      });
      expect(reduceBrowserPresentation(configured, { type: "agent-browser-started" })).toEqual(configured);
      expect(configured.runtime.mode).toBe("hidden");
    }
  });

  test("attention never steals layout from a user who hid the browser", () => {
    const suppressed = state([
      { type: "agent-browser-started" },
      { type: "user-hide-peek" },
      { type: "attention-required", reason: "authentication", url: "https://github.com/login" },
    ]);

    expect(suppressed.runtime.mode).toBe("hidden");
    expect(suppressed.runtime.attention).toMatchObject({
      reason: "authentication",
      url: "https://github.com/login",
      host: "github.com",
    });

    const opened = reduceBrowserPresentation(suppressed, { type: "user-open-browser" });
    expect(opened.runtime.mode).toBe("docked");
    expect(reduceBrowserPresentation(opened, { type: "attention-resolved" }).runtime.attention).toBeNull();
  });

  test("attention surfaces Peek when the user has not opted out", () => {
    const surfaced = state([
      { type: "agent-browser-started" },
      { type: "attention-required", reason: "captcha", url: "https://example.com/challenge" },
    ]);
    expect(surfaced.runtime.mode).toBe("peek");
    expect(surfaced.runtime.attention?.reason).toBe("captcha");
  });

  test("Expand remembers the exact presentation it came from", () => {
    // An expanded surface restores to the split it was opened from. Docked
    // keeps its width; expanding from Peek lands on the split rather than
    // dropping the user back into a floating card.
    const fromPeek = state([
      { type: "agent-browser-started" },
      { type: "user-open-browser" },
      { type: "user-expand-browser" },
    ]);
    expect(fromPeek.runtime.mode).toBe("expanded");
    expect(reduceBrowserPresentation(fromPeek, { type: "user-restore-browser" }).runtime.mode).toBe("docked");

    const fromDocked = state([
      { type: "agent-browser-started" },
      { type: "user-dock-browser", width: 684 },
      { type: "user-expand-browser" },
    ]);
    expect(fromDocked.runtime.restore).toEqual({ mode: "docked", width: 684 });
    const restored = reduceBrowserPresentation(fromDocked, { type: "user-restore-browser" });
    expect(restored.runtime.mode).toBe("docked");
    expect(restored.preferences.dockedWidth).toBe(684);
  });

  test("closing the last tab hides the surface; a new task resets runtime but keeps preferences", () => {
    const closed = state([
      { type: "agent-browser-started" },
      { type: "attention-required", reason: "permission", url: "https://example.com/settings" },
      { type: "last-browser-tab-closed" },
    ]);
    expect(closed.runtime.mode).toBe("hidden");
    expect(closed.runtime.attention).toBeNull();
    expect(closed.runtime.restore).toBeNull();

    const docked = state([{ type: "user-dock-browser", width: 700 }, { type: "user-hide-peek" }]);
    const nextTask = reduceBrowserPresentation(docked, { type: "session-changed" });
    expect(nextTask.runtime).toEqual({
      mode: "hidden",
      restore: null,
      peekSuppressed: false,
      attention: null,
      peekPosition: null,
    });
    expect(nextTask.preferences.dockedWidth).toBe(700);
  });

  test("persisted preferences are the only durable part", () => {
    const fresh = createBrowserPresentationState();
    expect(PERSISTED_BROWSER_PRESENTATION_KEY).toBe("sofia:browser-presentation:v1");
    expect(fresh.runtime).toEqual({
      mode: "hidden",
      restore: null,
      peekSuppressed: false,
      attention: null,
      peekPosition: null,
    });
    expect(fresh.preferences.autoShow).toBe("always");
    // Widths are clamped into a dockable range.
    expect(clampDockedWidth(10)).toBe(320);
    expect(clampDockedWidth(99999)).toBe(1600);
  });

  test("the peek card is a glanceable desktop preview, never a phone", () => {
    // Geometry is owned by the presentation: it does not read the workspace, the
    // page, or anything that a navigation could change.
    expect(browserPeekSize()).toEqual({ width: BROWSER_PEEK_WIDTH, height: BROWSER_PEEK_HEIGHT });
    expect(browserPeekSize()).toEqual(browserPeekSize());
    expect(browserAttentionHost("https://www.example.com/x")).toBe("example.com");
  });

  test("the peek card hugs the shape of the content it holds", () => {
    // A panel tab renders at Peek's desktop breakpoint, and 440 × 800/1280 is
    // exactly the 16:10 card the preview has always used.
    expect(browserPeekViewport({ mode: "panel" })).toEqual({
      width: BROWSER_PEEK_VIEWPORT.width,
      height: BROWSER_PEEK_VIEWPORT.height,
    });
    expect(browserPeekSize({ mode: "panel" })).toEqual({
      width: BROWSER_PEEK_WIDTH,
      height: BROWSER_PEEK_HEIGHT,
    });

    // Every preset the browser ships offers a device's real shape, so each one
    // gets a card of that shape: the page fills the card instead of sitting in
    // a letterbox inside a 16:10 box that was never its shape to begin with.
    const tablet = { mode: "responsive" as const, width: 768, height: 1024, deviceScaleFactor: 2 };
    const phone = { mode: "responsive" as const, width: 390, height: 844, deviceScaleFactor: 3 };
    expect(browserPeekViewport(tablet)).toEqual({ width: 768, height: 1024 });
    expect(browserPeekSize(tablet)).toEqual({ width: 240, height: 320 });
    expect(browserPeekSize(phone)).toEqual({ width: 148, height: 320 });

    for (const viewport of [
      { mode: "responsive" as const, width: 1440, height: 900, deviceScaleFactor: 1 },
      { mode: "responsive" as const, width: 1280, height: 800, deviceScaleFactor: 1 },
      tablet,
      phone,
      { mode: "responsive" as const, width: 1024, height: 768, deviceScaleFactor: 2 },
      { mode: "responsive" as const, width: 640, height: 480, deviceScaleFactor: 1 },
    ]) {
      const card = browserPeekSize(viewport);
      // The card is the content's own aspect, to the pixel we can round to.
      expect(card.width / card.height).toBeCloseTo(viewport.width / viewport.height, 2);
      // …and never bigger than the footprint, unless the floor grew it.
      expect(card.width).toBeLessThanOrEqual(Math.max(BROWSER_PEEK_WIDTH, MIN_BROWSER_PEEK_WIDTH));
      expect(card.height).toBeLessThanOrEqual(MAX_BROWSER_PEEK_HEIGHT);
    }
  });

  test("an extreme preset stops at the card's floor and ceiling", () => {
    // 390×844 at the default width would be 952 tall, so the card stops at the
    // ceiling and narrows instead — a phone preview is tall, not wide.
    const phone = { mode: "responsive" as const, width: 390, height: 844, deviceScaleFactor: 3 };
    expect(browserPeekSize(phone).height).toBe(MAX_BROWSER_PEEK_HEIGHT);
    expect(browserPeekSize(phone).width).toBeLessThan(BROWSER_PEEK_WIDTH);

    // An ultrawide preset is the opposite case: the floor keeps the card tall
    // enough to grab, which widens it past the default rather than flattening it.
    const ultrawide = { mode: "responsive" as const, width: 3840, height: 1080, deviceScaleFactor: 1 };
    const card = browserPeekSize(ultrawide);
    expect(card.height).toBe(MIN_BROWSER_PEEK_HEIGHT);
    expect(card.width).toBeGreaterThan(BROWSER_PEEK_WIDTH);

    // Position maths uses the hugged card, so a narrower card still lands
    // fully inside the workspace instead of hanging off the right edge.
    const surface = { width: 1200, height: 800 };
    expect(defaultPeekPosition(surface, browserPeekSize(phone))).toEqual({
      x: 1200 - 148 - 20,
      y: 64,
    });
    expect(clampPeekPosition({ x: 0, y: 500 }, surface, browserPeekSize(phone))).toEqual({
      x: 16,
      y: 800 - MAX_BROWSER_PEEK_HEIGHT - 16,
    });
  });

  test("presentation decides visibility, and never hides the conversation", () => {
    expect(browserPresentationVisible("hidden")).toBe(false);
    expect(browserPresentationVisible("peek")).toBe(true);
    expect(browserPresentationVisible("expanded")).toBe(true);
  });

  test("Expanded gives the browser the dominant share of the workspace", () => {
    // Roughly 60/40 in favour of the browser, clamped so neither extreme is
    // possible on a very narrow or a very wide workspace.
    expect(browserExpandedWidth(1400)).toBe(840);
    expect(browserExpandedWidth(2600)).toBe(MAX_BROWSER_EXPANDED_WIDTH);
    expect(browserExpandedWidth(600)).toBe(MIN_BROWSER_EXPANDED_WIDTH);
    // A workspace that has not been measured yet must not collapse the panel.
    expect(browserExpandedWidth(0)).toBe(MIN_BROWSER_EXPANDED_WIDTH);
  });

  test("the card rests clear of the workspace header, and is clamped inside it", () => {
    const surface = { width: 1200, height: 800 };
    const resting = defaultPeekPosition(surface);
    expect(resting.x).toBe(1200 - BROWSER_PEEK_WIDTH - 20);
    expect(resting.y).toBe(64);
    expect(clampPeekPosition(resting, surface)).toEqual(resting);

    // A narrowed workspace pulls the card back inside instead of stranding it.
    expect(clampPeekPosition(resting, { width: 900, height: 400 })).toEqual({
      x: 900 - BROWSER_PEEK_WIDTH - 16,
      y: 64,
    });
    // A workspace barely taller than the card leaves the resting y in range, so
    // the clamp is a no-op rather than pulling the card to the bottom margin.
    expect(clampPeekPosition(resting, { width: 900, height: 320 }).y).toBe(64);
    // Shrink it until the card genuinely cannot fit: the clamp falls back to the
    // margin rather than returning a negative position.
    expect(clampPeekPosition(resting, { width: 900, height: 200 }).y).toBe(16);
    expect(clampPeekPosition({ x: -50, y: -50 }, { width: 900, height: 400 })).toEqual({ x: 16, y: 16 });
    // Narrower than the card: it sits at the margin rather than off-screen.
    expect(clampPeekPosition(resting, { width: 300, height: 200 })).toEqual({ x: 16, y: 16 });
  });

  test("a drag moves the card and a click opens the browser", () => {
    const surface = { width: 1200, height: 800 };
    const origin = { x: 700, y: 64 };

    const click = movePeekDrag(beginPeekDrag(origin), 2, 3);
    expect(click.dragging).toBe(false);
    expect(peekDragPosition(click, surface)).toEqual(origin);

    const dragged = movePeekDrag(movePeekDrag(beginPeekDrag(origin), 4, 0), 25, 40);
    expect(dragged.dragging).toBe(true);
    expect(peekDragPosition(dragged, surface)).toEqual({ x: 725, y: 104 });

    // Dragging past an edge clamps, so the card can never leave the workspace.
    const past = movePeekDrag(beginPeekDrag(origin), 900, 900);
    expect(peekDragPosition(past, surface)).toEqual({
      x: 1200 - BROWSER_PEEK_WIDTH - 16,
      y: 800 - BROWSER_PEEK_HEIGHT - 16,
    });
    // Once a gesture is a drag it stays one, even when the pointer comes back.
    expect(movePeekDrag(dragged, 0, 0).dragging).toBe(true);
  });

  test("a dragged position is task state, and a new task starts fresh", () => {
    const moved = reduceBrowserPresentation(state([{ type: "agent-browser-started" }]), {
      type: "user-move-peek",
      position: { x: 300, y: 120 },
    });
    expect(moved.runtime.peekPosition).toEqual({ x: 300, y: 120 });
    // Dragging is presentation-only: it never changes what the browser is doing.
    expect(moved.runtime.mode).toBe("peek");

    expect(reduceBrowserPresentation(moved, { type: "session-changed" }).runtime.peekPosition).toBeNull();
  });
});
