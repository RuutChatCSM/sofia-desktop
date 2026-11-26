import { test } from "@sofia/testkit";
import { expect } from "vitest";

import {
  moveSessionDockBounds,
  nearestSessionDockCorner,
  normalizeSessionDockLayout,
  normalizeSessionDockTarget,
  sessionDockBounds,
  sessionDockUrl,
} from "../../apps/desktop/electron/browser-session-dock.mjs";

const WINDOW = { windowWidth: 1280, windowHeight: 800 };
const APP_URL = "file:///Applications/Sofia.app/Contents/Resources/app-dist/index.html";

test("the dock has panel, bar and bubble geometry in every corner", async ({ evidence }) => {
  expect(sessionDockBounds({ ...WINDOW, corner: "bottom-right", size: "panel" }))
    .toEqual({ x: 824, y: 164, width: 440, height: 620 });
  expect(sessionDockBounds({ ...WINDOW, corner: "bottom-left", size: "panel" }))
    .toEqual({ x: 16, y: 164, width: 440, height: 620 });
  expect(sessionDockBounds({ ...WINDOW, corner: "top-right", size: "panel" }))
    .toEqual({ x: 824, y: 16, width: 440, height: 620 });
  expect(sessionDockBounds({ ...WINDOW, corner: "bottom-right", size: "bar" }))
    .toEqual({ x: 704, y: 688, width: 560, height: 96 });
  expect(sessionDockBounds({ ...WINDOW, corner: "bottom-right", size: "bubble" }))
    .toEqual({ x: 1208, y: 728, width: 56, height: 56 });
  expect(sessionDockBounds({ ...WINDOW, zoom: 1.25, corner: "bottom-right", size: "panel" }))
    .toEqual({ x: 710, y: 5, width: 550, height: 775 });
  evidence.recordAssertionEvidence(
    "The dock keeps three sizes and follows the chosen corner and zoom",
    "Panel is 440x620, bar 560x96, bubble 56x56; 1.25 zoom scales the panel to 550x775 DIP.",
    true,
  );
});

test("dragging snaps to the nearest offered corner", async ({ evidence }) => {
  const start = sessionDockBounds({ ...WINDOW, corner: "bottom-right", size: "panel" });
  const moved = moveSessionDockBounds({ rect: start, dx: -900, dy: -600, ...WINDOW });
  expect(moved).toEqual({ x: 0, y: 0, width: 440, height: 620 });
  expect(nearestSessionDockCorner({ rect: moved, ...WINDOW })).toBe("top-right");
  expect(nearestSessionDockCorner({ rect: { x: 40, y: 600, width: 440, height: 620 }, ...WINDOW }))
    .toBe("bottom-left");
  evidence.recordAssertionEvidence(
    "A released drag resolves to one of the three dock corners",
    "A top-left release folds into top-right; a bottom-left release stays bottom-left.",
    true,
  );
});

test("the dock route is the real app, scoped to a workspace and session", async ({ evidence }) => {
  const url = sessionDockUrl(APP_URL, { workspaceId: "ws_1", sessionId: "codex-1" }, "bar");
  expect(url).toBe(`${APP_URL}#/dock?workspace=ws_1&session=codex-1&size=bar`);
  expect(normalizeSessionDockTarget({ workspaceId: " ws_1 ", sessionId: " codex-1 ", dark: true }))
    .toEqual({ workspaceId: "ws_1", sessionId: "codex-1", dark: true });
  expect(normalizeSessionDockTarget({ dark: "yes" }))
    .toEqual({ workspaceId: "", sessionId: "", dark: false });
  evidence.recordAssertionEvidence(
    "The native view loads the app's own #/dock route",
    "The URL carries workspace, session and an initial size; malformed targets sanitize to empty ids and light theme.",
    true,
  );
});

test("layout persistence carries the size and accepts legacy collapse", async ({ evidence }) => {
  expect(normalizeSessionDockLayout({ corner: "top-right", size: "bar" }))
    .toEqual({ corner: "top-right", size: "bar" });
  expect(normalizeSessionDockLayout({ corner: "missing", size: "huge" }))
    .toEqual({ corner: "bottom-right", size: "panel" });
  expect(normalizeSessionDockLayout({ corner: "bottom-left", collapsed: true }))
    .toEqual({ corner: "bottom-left", size: "bubble" });
  evidence.recordAssertionEvidence(
    "Size is persisted and sanitized like the corner",
    "Unknown sizes fall back to panel; a legacy collapsed profile opens as the bubble.",
    true,
  );
});
