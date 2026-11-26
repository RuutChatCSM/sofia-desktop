import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  SESSION_DOCK_BACK_CHANNEL,
  SESSION_DOCK_LAYOUT_CHANNEL,
  SESSION_DOCK_LAYOUT_STATE_CHANNEL,
  SESSION_DOCK_SIZE,
  SESSION_DOCK_THEME_CHANNEL,
  createBrowserSessionDock,
  moveSessionDockBounds,
  nearestSessionDockCorner,
  normalizeSessionDockLayout,
  normalizeSessionDockTarget,
  readSessionDockLayout,
  sessionDockBounds,
  sessionDockUrl,
  writeSessionDockLayout,
} from "./browser-session-dock.mjs";

const WINDOW = { windowWidth: 1280, windowHeight: 800 };
const APP_URL = "file:///Applications/Sofia.app/Contents/Resources/app-dist/index.html";

function fakeDock() {
  const loads = [];
  const sent = [];
  let bounds = { x: 0, y: 0, width: 0, height: 0 };
  const view = {
    webContents: {
      isDestroyed: () => false,
      setWindowOpenHandler: () => {},
      once: () => {},
      loadURL: async (url) => { loads.push(url); },
      send: (channel, payload) => { sent.push({ channel, payload }); },
      close: () => {},
    },
    setBackgroundColor: () => {},
    setVisible: () => {},
    getBounds: () => bounds,
    setBounds: (next) => { bounds = next; },
  };
  const children = [];
  const mainWindow = {
    getContentSize: () => [1280, 800],
    contentView: {
      children,
      addChildView: (child) => { children.push(child); },
      removeChildView: (child) => {
        const index = children.indexOf(child);
        if (index >= 0) children.splice(index, 1);
      },
    },
  };
  return { view, mainWindow, loads, sent };
}

describe("session dock geometry", () => {
  it("anchors panel, bar and bubble sizes in each offered corner", () => {
    assert.deepEqual(
      sessionDockBounds({ ...WINDOW, corner: "bottom-right", size: "panel" }),
      { x: 824, y: 164, width: 440, height: 620 },
    );
    assert.deepEqual(
      sessionDockBounds({ ...WINDOW, corner: "bottom-left", size: "panel" }),
      { x: 16, y: 164, width: 440, height: 620 },
    );
    assert.deepEqual(
      sessionDockBounds({ ...WINDOW, corner: "top-right", size: "panel" }),
      { x: 824, y: 16, width: 440, height: 620 },
    );
    assert.deepEqual(
      sessionDockBounds({ ...WINDOW, corner: "bottom-right", size: "bar" }),
      { x: 704, y: 688, width: 560, height: 96 },
    );
    assert.deepEqual(
      sessionDockBounds({ ...WINDOW, corner: "bottom-right", size: "bubble" }),
      { x: 1208, y: 728, width: 56, height: 56 },
    );
  });

  it("scales every size by window zoom and clamps to a tiny window", () => {
    assert.deepEqual(
      sessionDockBounds({ ...WINDOW, zoom: 1.25, corner: "bottom-right", size: "panel" }),
      { x: 710, y: 5, width: 550, height: 775 },
    );
    assert.deepEqual(
      sessionDockBounds({ ...WINDOW, zoom: 1.25, corner: "bottom-right", size: "bar" }),
      { x: 560, y: 660, width: 700, height: 120 },
    );
    assert.deepEqual(
      sessionDockBounds({ ...WINDOW, zoom: 1.25, corner: "bottom-right", size: "bubble" }),
      { x: 1190, y: 710, width: 70, height: 70 },
    );
    assert.deepEqual(
      sessionDockBounds({ windowWidth: 180, windowHeight: 90, corner: "bottom-right", size: "panel" }),
      { x: 0, y: 0, width: 180, height: 90 },
    );
  });

  it("moves a dragged dock and snaps it to the nearest offered corner", () => {
    const start = sessionDockBounds({ ...WINDOW, corner: "bottom-right", size: "panel" });
    const moved = moveSessionDockBounds({ rect: start, dx: -900, dy: -600, ...WINDOW });
    assert.deepEqual(moved, { x: 0, y: 0, width: 440, height: 620 });
    assert.equal(nearestSessionDockCorner({ rect: moved, ...WINDOW }), "top-right");
    assert.equal(
      nearestSessionDockCorner({ rect: { x: 40, y: 600, width: 440, height: 620 }, ...WINDOW }),
      "bottom-left",
    );
    // A top-left release folds into the only offered top corner.
    assert.equal(
      nearestSessionDockCorner({ rect: { x: 0, y: 0, width: 440, height: 620 }, ...WINDOW }),
      "top-right",
    );
  });

  it("keeps every size policy in one place", () => {
    assert.deepEqual(SESSION_DOCK_SIZE.panel, { width: 440, height: 620 });
    assert.deepEqual(SESSION_DOCK_SIZE.bar, { width: 560, height: 96 });
    assert.deepEqual(SESSION_DOCK_SIZE.bubble, { width: 56, height: 56 });
  });
});

describe("session dock target and preferences", () => {
  it("sanitizes the target and drops obsolete live-turn fields", () => {
    const target = normalizeSessionDockTarget({
      workspaceId: "  ws_1  ",
      sessionId: " codex-1 ",
      dark: true,
      title: "Running tests",
      tone: "thinking",
    });
    assert.deepEqual(target, { workspaceId: "ws_1", sessionId: "codex-1", dark: true });
    assert.deepEqual(normalizeSessionDockTarget({ dark: "yes" }), { workspaceId: "", sessionId: "", dark: false });
  });

  it("persists corner and size across restarts, accepting the legacy collapse flag", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "sofia-session-dock-"));
    const file = path.join(directory, "dock.json");
    try {
      writeSessionDockLayout(file, { corner: "bottom-left", size: "bar" });
      assert.deepEqual(readSessionDockLayout(file), { corner: "bottom-left", size: "bar" });
      assert.deepEqual(normalizeSessionDockLayout({ corner: "missing", size: "huge" }), {
        corner: "bottom-right",
        size: "panel",
      });
      assert.deepEqual(normalizeSessionDockLayout({ corner: "top-right", collapsed: true }), {
        corner: "top-right",
        size: "bubble",
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("builds the real app dock route with an initial size hint", () => {
    const url = sessionDockUrl(APP_URL, { workspaceId: "ws_1", sessionId: "codex-1" }, "bar");
    assert.equal(url, `${APP_URL}#/dock?workspace=ws_1&session=codex-1&size=bar`);
    assert.equal(sessionDockUrl(APP_URL, null, "panel"), `${APP_URL}#/dock?size=panel`);
  });
});

describe("session dock lifecycle", () => {
  it("navigates only when the session changes and resizes with setBounds", () => {
    const { view, mainWindow, loads, sent } = fakeDock();
    const directory = mkdtempSync(path.join(os.tmpdir(), "sofia-session-dock-"));
    const preferencesPath = path.join(directory, "dock.json");
    const events = [];
    try {
      const dock = createBrowserSessionDock({
        getWindow: () => mainWindow,
        getZoomFactor: () => 1,
        getAppUrl: () => APP_URL,
        createView: () => view,
        bringToTop: () => {},
        sendToRenderer: (channel) => { events.push(channel); },
        preferencesPath,
      });
      dock.show();
      assert.equal(loads.at(-1), `${APP_URL}#/dock?size=panel`);
      assert.deepEqual(view.getBounds(), { x: 824, y: 164, width: 440, height: 620 });

      dock.setTarget({ workspaceId: "ws_1", sessionId: "codex-1", dark: true });
      assert.equal(loads.at(-1), `${APP_URL}#/dock?workspace=ws_1&session=codex-1&size=panel`);
      const loadCount = loads.length;
      dock.setTarget({ workspaceId: "ws_1", sessionId: "codex-1", dark: true });
      assert.equal(loads.length, loadCount);
      dock.setTarget({ workspaceId: "ws_1", sessionId: "codex-2", dark: true });
      assert.equal(loads.length, loadCount + 1);

      assert.equal(dock.markReady(view.webContents), true);
      assert.ok(sent.some((entry) => entry.channel === SESSION_DOCK_LAYOUT_STATE_CHANNEL));
      assert.deepEqual(
        sent.findLast((entry) => entry.channel === SESSION_DOCK_THEME_CHANNEL)?.payload,
        { dark: true },
      );

      dock.setLayout({ size: "bar" });
      assert.deepEqual(view.getBounds(), { x: 704, y: 688, width: 560, height: 96 });
      dock.setLayout({ size: "bubble" });
      assert.deepEqual(view.getBounds(), { x: 1208, y: 728, width: 56, height: 56 });

      assert.equal(dock.handleAction(SESSION_DOCK_LAYOUT_CHANNEL, { size: "panel" }, "other"), false);
      assert.equal(dock.getLayout().size, "bubble");
      assert.equal(dock.handleAction(SESSION_DOCK_LAYOUT_CHANNEL, { size: "panel" }, view.webContents), true);
      assert.equal(dock.getLayout().size, "panel");
      assert.equal(dock.handleAction(SESSION_DOCK_BACK_CHANNEL, null, view.webContents), true);
      assert.equal(events.at(-1), "sofia:browser:session-dock-back-to-chat");
      assert.equal(dock.handleAction(SESSION_DOCK_BACK_CHANNEL, null, "other"), false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
