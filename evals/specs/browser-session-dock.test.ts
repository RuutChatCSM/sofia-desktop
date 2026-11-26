import { test } from "@sofia/testkit";
import { expect } from "vitest";

import {
  moveSessionDockBounds,
  nearestSessionDockCorner,
  normalizeSessionDockState,
  sessionDockBounds,
} from "../../apps/desktop/electron/browser-session-dock.mjs";
import { createDockStatePublisher } from "../../apps/app/src/react-app/domains/session/surface/browser-session-dock-state";
import type { BrowserSessionDockState } from "../../apps/app/src/app/lib/desktop-types";

const WINDOW = { windowWidth: 1280, windowHeight: 800 };

function dockState(title: string): BrowserSessionDockState {
  return { title, tone: "working", meta: ["1m"], note: "", running: true, mode: "steer", dark: true };
}

test("full-screen dock bounds follow the chosen corner, zoom, and collapse", async ({ evidence }) => {
  expect(sessionDockBounds({ ...WINDOW, corner: "bottom-right", collapsed: false }))
    .toEqual({ x: 884, y: 652, width: 380, height: 132 });
  expect(sessionDockBounds({ ...WINDOW, corner: "bottom-left", collapsed: false }))
    .toEqual({ x: 16, y: 652, width: 380, height: 132 });
  expect(sessionDockBounds({ ...WINDOW, corner: "top-right", collapsed: false }))
    .toEqual({ x: 884, y: 16, width: 380, height: 132 });
  expect(sessionDockBounds({ ...WINDOW, corner: "bottom-right", collapsed: true }))
    .toEqual({ x: 1044, y: 744, width: 220, height: 40 });
  expect(sessionDockBounds({ ...WINDOW, zoom: 1.25, corner: "bottom-right", collapsed: false }))
    .toEqual({ x: 785, y: 615, width: 475, height: 165 });
  evidence.recordAssertionEvidence(
    "Dock geometry is anchored, zoom-aware, and collapses to a pill",
    "Each corner places the 380x132 card 16 CSS pixels from the edge; a 1.25 zoom scales it to 475x165 DIP; collapse uses 220x40.",
    true,
  );
});

test("dragging the dock header snaps to the nearest offered corner", async ({ evidence }) => {
  const start = sessionDockBounds({ ...WINDOW, corner: "bottom-right", collapsed: false });
  const moved = moveSessionDockBounds({ rect: start, dx: -900, dy: -600, ...WINDOW });
  expect(moved).toEqual({ x: 0, y: 52, width: 380, height: 132 });
  expect(nearestSessionDockCorner({ rect: moved, ...WINDOW })).toBe("top-right");
  expect(nearestSessionDockCorner({ rect: { x: 40, y: 600, width: 380, height: 132 }, ...WINDOW })).toBe("bottom-left");
  evidence.recordAssertionEvidence(
    "A released drag resolves to one of the three dock corners",
    "A top-left release folds into top-right; a bottom-left release stays bottom-left.",
    true,
  );
});

test("dock state is throttled to four updates per second, newest wins", async ({ evidence }) => {
  const sent: BrowserSessionDockState[] = [];
  let now = 0;
  let scheduled: { callback: () => void; at: number } | null = null;
  const publisher = createDockStatePublisher((state) => sent.push(state), {
    now: () => now,
    schedule: (callback, delayMs) => {
      scheduled = { callback, at: now + delayMs };
      return 1;
    },
    cancel: () => { scheduled = null; },
  });
  publisher.publish(dockState("first"));
  expect(sent.map((state) => state.title)).toEqual(["first"]);
  publisher.publish(dockState("second"));
  publisher.publish(dockState("third"));
  expect(sent.map((state) => state.title)).toEqual(["first"]);
  expect(scheduled?.at).toBe(250);
  now = 250;
  scheduled?.callback();
  expect(sent.map((state) => state.title)).toEqual(["first", "third"]);
  publisher.publish(dockState("third"));
  expect(sent.map((state) => state.title)).toEqual(["first", "third"]);
  publisher.stop();
  evidence.recordAssertionEvidence(
    "The renderer publishes at most four dock updates per second",
    "Two synchronous turns collapse into one scheduled send, and a duplicate state is dropped.",
    true,
  );
});

test("renderer state is sanitized before it reaches the native dock", async ({ evidence }) => {
  const state = normalizeSessionDockState(
    { title: "Running tests", tone: "thinking", meta: ["2m", "3 steps"], running: true, mode: "queue", dark: true },
    { corner: "top-right", collapsed: true },
  );
  expect(state).toMatchObject({
    title: "Running tests",
    tone: "thinking",
    meta: ["2m", "3 steps"],
    running: true,
    mode: "queue",
    dark: true,
    corner: "top-right",
    collapsed: true,
  });
  const fallback = normalizeSessionDockState({ title: "", tone: "loud", mode: "bogus" }, "missing");
  expect(fallback).toMatchObject({ title: "Sofia", tone: "working", mode: "send", corner: "bottom-right", collapsed: false });
  evidence.recordAssertionEvidence(
    "Malformed dock payloads fall back instead of reaching the native document",
    "Invalid tone, mode and corner become working/send/bottom-right; the live layout is always attached.",
    true,
  );
});
