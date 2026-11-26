import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  BROWSER_SESSION_DOCK_DOCUMENT,
  SESSION_DOCK_SIZE,
  browserSessionDockUrl,
  moveSessionDockBounds,
  nearestSessionDockCorner,
  normalizeSessionDockLayout,
  normalizeSessionDockState,
  readSessionDockLayout,
  sessionDockBounds,
  writeSessionDockLayout,
} from "./browser-session-dock.mjs";

const WINDOW = { windowWidth: 1280, windowHeight: 800 };

describe("session dock geometry", () => {
  it("anchors the expanded card in each offered corner", () => {
    const right = sessionDockBounds({ ...WINDOW, corner: "bottom-right", collapsed: false });
    assert.deepEqual(right, { x: 1280 - 380 - 16, y: 800 - 132 - 16, width: 380, height: 132 });
    assert.deepEqual(
      sessionDockBounds({ ...WINDOW, corner: "bottom-left", collapsed: false }),
      { x: 16, y: 800 - 132 - 16, width: 380, height: 132 },
    );
    assert.deepEqual(
      sessionDockBounds({ ...WINDOW, corner: "top-right", collapsed: false }),
      { x: 1280 - 380 - 16, y: 16, width: 380, height: 132 },
    );
  });

  it("uses the collapsed pill size and clamps to a tiny window", () => {
    assert.deepEqual(
      sessionDockBounds({ ...WINDOW, corner: "bottom-right", collapsed: true }),
      { x: 1280 - 220 - 16, y: 800 - 40 - 16, width: 220, height: 40 },
    );
    assert.deepEqual(
      sessionDockBounds({ windowWidth: 180, windowHeight: 90, corner: "bottom-right", collapsed: false }),
      { x: 0, y: 0, width: 180, height: 90 },
    );
  });

  it("scales the CSS-pixel card by the window zoom factor", () => {
    const bounds = sessionDockBounds({ ...WINDOW, zoom: 1.25, corner: "bottom-right", collapsed: false });
    assert.deepEqual(bounds, {
      x: 1280 - 475 - 20,
      y: 800 - 165 - 20,
      width: 475,
      height: 165,
    });
  });

  it("moves a dragged card and snaps it to the nearest offered corner", () => {
    const start = sessionDockBounds({ ...WINDOW, corner: "bottom-right", collapsed: false });
    const moved = moveSessionDockBounds({ rect: start, dx: -900, dy: -600, ...WINDOW });
    assert.deepEqual(moved, { x: 0, y: 52, width: 380, height: 132 });
    assert.equal(nearestSessionDockCorner({ rect: moved, ...WINDOW }), "top-right");
    assert.equal(
      nearestSessionDockCorner({ rect: { x: 40, y: 600, width: 380, height: 132 }, ...WINDOW }),
      "bottom-left",
    );
    // A top-left release folds into the only offered top corner.
    assert.equal(
      nearestSessionDockCorner({ rect: { x: 0, y: 0, width: 380, height: 132 }, ...WINDOW }),
      "top-right",
    );
  });

  it("keeps every size policy in one place", () => {
    assert.deepEqual(SESSION_DOCK_SIZE.expanded, { width: 380, height: 132 });
    assert.deepEqual(SESSION_DOCK_SIZE.collapsed, { width: 220, height: 40 });
  });
});

describe("session dock state and preferences", () => {
  it("sanitizes renderer state and always carries the live layout", () => {
    const state = normalizeSessionDockState(
      { title: "Running tests", tone: "thinking", meta: ["2m", "3 steps"], note: "Checking the route.", running: true, mode: "steer", dark: true },
      { corner: "top-right", collapsed: true },
    );
    assert.deepEqual(state, {
      title: "Running tests",
      tone: "thinking",
      meta: ["2m", "3 steps"],
      note: "Checking the route.",
      running: true,
      mode: "steer",
      dark: true,
      corner: "top-right",
      collapsed: true,
    });
  });

  it("falls back to safe values for malformed state", () => {
    const state = normalizeSessionDockState({ title: "", tone: "loud", meta: [1, "ok"], mode: "bogus" }, "nope");
    assert.equal(state.title, "Sofia");
    assert.equal(state.tone, "working");
    assert.deepEqual(state.meta, ["ok"]);
    assert.equal(state.mode, "send");
    assert.equal(state.corner, "bottom-right");
    assert.equal(state.collapsed, false);
  });

  it("persists corner and collapse across restarts", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "sofia-session-dock-"));
    const file = path.join(directory, "dock.json");
    try {
      writeSessionDockLayout(file, { corner: "bottom-left", collapsed: true });
      assert.deepEqual(readSessionDockLayout(file), { corner: "bottom-left", collapsed: true });
      assert.deepEqual(normalizeSessionDockLayout({ corner: "missing", collapsed: "yes" }), {
        corner: "bottom-right",
        collapsed: false,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("session dock document", () => {
  it("is a transparent native layer with a keyboard composer", () => {
    const url = browserSessionDockUrl();
    assert.ok(url.startsWith("data:text/html;charset=utf-8,"));
    assert.ok(url.endsWith("#sofia-internal-session-dock"));
    assert.match(BROWSER_SESSION_DOCK_DOCUMENT, /html, body \{[^}]*background: transparent/);
    assert.match(BROWSER_SESSION_DOCK_DOCUMENT, /<textarea id="input"/);
    assert.match(BROWSER_SESSION_DOCK_DOCUMENT, /event\.key === "Enter" && !event\.shiftKey/);
    assert.match(BROWSER_SESSION_DOCK_DOCUMENT, /prefers-reduced-motion/);
    assert.match(BROWSER_SESSION_DOCK_DOCUMENT, /aria-label="Back to chat"|Back to chat/);
  });

  it("drags only the header and snaps on release", () => {
    assert.match(BROWSER_SESSION_DOCK_DOCUMENT, /header\.addEventListener\("pointerdown"/);
    assert.match(BROWSER_SESSION_DOCK_DOCUMENT, /api\.dragBy\(event\.screenX - drag\.x, event\.screenY - drag\.y, "move"\)/);
    assert.match(BROWSER_SESSION_DOCK_DOCUMENT, /api\.dragBy\(event\.screenX - drag\.x, event\.screenY - drag\.y, cancelled \? "cancel" : "end"\)/);
    assert.match(BROWSER_SESSION_DOCK_DOCUMENT, /api\.setLayout\(\{ corner: latest\.corner, collapsed: collapsed \}\)/);
  });
});
