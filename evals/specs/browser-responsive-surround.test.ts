import { readFile } from "node:fs/promises";

import { expect } from "vitest";
import { test } from "@sofia/testkit";

import {
  BROWSER_PAGE_BACKGROUND,
  BROWSER_SURROUND_BACKGROUND_DARK,
  BROWSER_SURROUND_BACKGROUND_LIGHT,
  RESPONSIVE_FRAME_MARGIN_PX,
  browserViewBackground,
  resolveViewportPlan,
} from "../../apps/desktop/electron/browser-tab-state.mjs";

const PANEL_SOURCE_URL = new URL("../../apps/desktop/electron/browser-panel.mjs", import.meta.url);

test("a responsive device frame letterboxes onto a grey cutout, never white", async ({ evidence }) => {
  expect(browserViewBackground({ responsive: true, dark: false })).toBe(BROWSER_SURROUND_BACKGROUND_LIGHT);
  expect(browserViewBackground({ responsive: true, dark: true })).toBe(BROWSER_SURROUND_BACKGROUND_DARK);
  expect(browserViewBackground({ responsive: false, dark: false })).toBe(BROWSER_PAGE_BACKGROUND);
  expect(browserViewBackground({ responsive: true, dark: false }).toLowerCase()).not.toBe(BROWSER_PAGE_BACKGROUND);
  expect(browserViewBackground({ responsive: true, dark: true }).toLowerCase()).not.toBe(BROWSER_PAGE_BACKGROUND);
  evidence.recordAssertionEvidence(
    "A responsive device frame is letterboxed in grey, not white",
    `The surround resolves to ${BROWSER_SURROUND_BACKGROUND_LIGHT} (light) / ${BROWSER_SURROUND_BACKGROUND_DARK} (dark) in responsive mode and only falls back to the page white ${BROWSER_PAGE_BACKGROUND} when the page fills the panel.`,
    true,
  );
});

test("the browser panel paints that surround on the native view as the viewport changes", async ({ evidence }) => {
  const panel = await readFile(PANEL_SOURCE_URL, "utf8");

  expect(panel).toContain("browserViewBackground({ responsive, dark: nativeTheme.shouldUseDarkColors })");
  expect(panel).toContain("tab.view.setBackgroundColor?.(");
  expect(panel).toContain("applyBrowserViewBackground(tab, Boolean(plan?.emulation))");
  expect(panel).toContain('nativeTheme.on?.("updated"');
  evidence.recordAssertionEvidence(
    "The panel drives the native view background from the applied viewport plan",
    "browser-panel.mjs sets the view background from browserViewBackground for every applied viewport plan and refreshes it when the app theme changes.",
    true,
  );
});

test("a fitted device frame never runs into the panel edge it used to spill over", async ({ evidence }) => {
  const bounds = { x: 0, y: 0, width: 876, height: 885 };
  const plan = resolveViewportPlan({
    viewport: { mode: "responsive", width: 1440, height: 900, deviceScaleFactor: 1 },
    zoom: { mode: "fit" },
    panelBounds: bounds,
  });
  const scale = plan.emulation?.scale ?? 0;
  expect(plan.bounds).not.toBeNull();
  const left = plan.bounds.x - bounds.x;
  const top = plan.bounds.y - bounds.y;
  const right = bounds.width - (left + plan.bounds.width);
  const bottom = bounds.height - (top + plan.bounds.height);
  expect(plan.emulation?.positionX).toBe(0);
  expect(plan.emulation?.positionY).toBe(0);

  for (const [edge, gap] of Object.entries({ left, right, top, bottom })) {
    expect(gap, `${edge} letterbox`).toBeGreaterThanOrEqual(RESPONSIVE_FRAME_MARGIN_PX - 1);
  }
  expect(plan.overflow).toEqual({ x: 0, y: 0 });
  evidence.recordAssertionEvidence(
    "A fitted responsive frame keeps a letterbox on every edge",
    `In an 876x885 canvas the 1440x900 frame is scaled to ${scale.toFixed(3)} and inset ${left.toFixed(1)}px left / ${right.toFixed(1)}px right / ${top.toFixed(1)}px top / ${bottom.toFixed(1)}px bottom, so the page can no longer run into the panel's right edge.`,
    true,
  );
});
