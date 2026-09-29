import { expect } from "vitest";
import { test } from "@sofia/testkit";
import { createViewportController } from "../../apps/desktop/electron/browser-tab-state.mjs";

test("responsive emulation leaves the visible native surface under Electron control", async ({ evidence }) => {
  const commands: { method: string; params: Record<string, unknown> }[] = [];
  const bounds: unknown[] = [];
  const controller = createViewportController({
    sendCommand: async (_tabId: string, method: string, params: Record<string, unknown>) => { commands.push({ method, params }); },
    setBounds: (_tabId: string, rect: unknown) => { bounds.push(rect); },
  });
  for (const width of [520, 1372]) {
    const plan = await controller.apply({ tabId: "page", viewport: { mode: "responsive", width: 1440, height: 900, deviceScaleFactor: 1 }, zoom: { mode: "fit" }, panelBounds: { x: 280, y: 160, width, height: 860 } });
    expect(bounds.at(-1)).toEqual(plan.bounds);
    expect(Math.abs(plan.bounds.x + plan.bounds.width / 2 - 280 - width / 2)).toBeLessThanOrEqual(0.5);
    expect(plan.bounds.x).toBeGreaterThanOrEqual(280);
    expect(plan.bounds.x + plan.bounds.width).toBeLessThanOrEqual(280 + width);
    expect(plan.bounds.y + plan.bounds.height).toBeLessThanOrEqual(1020);
    expect(commands.at(-1)?.params).toMatchObject({ width: 1440, height: 900, dontSetVisibleSize: true });
  }
  evidence.recordAssertionEvidence("Responsive page metrics do not resize the native visible surface", "Split and expanded canvas bounds remain authoritative while Chromium receives a 1440×900 page viewport with visible-size changes disabled.", true);
});

test("phone frame is centered at its scaled size inside the native stage", async ({ evidence }) => {
  const controller = createViewportController({ sendCommand: async () => {}, setBounds: () => {} });
  const plan = await controller.apply({ tabId: "phone", viewport: { mode: "responsive", width: 390, height: 844, deviceScaleFactor: 1 }, zoom: { mode: "actual" }, panelBounds: { x: 280, y: 160, width: 1400, height: 900 } });
  expect(plan.bounds).toEqual({ x: 785, y: 188, width: 390, height: 844 });
  expect(plan.emulation).toMatchObject({ width: 390, height: 844, positionX: 0, positionY: 0 });
  evidence.recordAssertionEvidence("A phone has balanced margins and its own 390×844 native frame", "The frame is centered within a 1400×900 stage, while emulated content starts at its own origin.", true);
});
