import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  BROWSER_PEEK_VIEWPORT,
  BROWSER_PAGE_BACKGROUND,
  BROWSER_SURROUND_BACKGROUND_DARK,
  BROWSER_SURROUND_BACKGROUND_LIGHT,
  RESPONSIVE_FRAME_MARGIN_PX,
  browserPeekLayoutZoom,
  browserViewBackground,
  effectiveBrowserViewport,
  createAgentLeaseRegistry,
  createBrowserTabRuntimeState,
  createViewportController,
  resolvePageZoomFactor,
  resolveViewportPlan,
  resolveViewportScale,
  transitionPageState,
} from "./browser-tab-state.mjs";

const RESPONSIVE_1440 = { mode: "responsive", width: 1440, height: 900, deviceScaleFactor: 1 };

describe("browser view background", () => {
  it("keeps the default white behind a page that follows the panel", () => {
    assert.equal(browserViewBackground({ responsive: false, dark: false }), BROWSER_PAGE_BACKGROUND);
    assert.equal(browserViewBackground({ responsive: false, dark: true }), BROWSER_PAGE_BACKGROUND);
  });

  it("greys the cutout around a responsive device frame", () => {
    assert.equal(browserViewBackground({ responsive: true, dark: false }), BROWSER_SURROUND_BACKGROUND_LIGHT);
    assert.equal(browserViewBackground({ responsive: true, dark: true }), BROWSER_SURROUND_BACKGROUND_DARK);
  });

  it("never leaves the surround white, in either theme", () => {
    for (const dark of [false, true]) {
      const surround = browserViewBackground({ responsive: true, dark });
      assert.notEqual(surround.toLowerCase(), BROWSER_PAGE_BACKGROUND);
    }
  });

  it("renders a Peek of a panel tab as desktop, without rewriting the tab viewport", () => {
    const panelTab = { mode: "panel" };

    assert.deepEqual(effectiveBrowserViewport(panelTab, "peek"), BROWSER_PEEK_VIEWPORT);
    // The durable intent is untouched by the presentation.
    assert.deepEqual(panelTab, { mode: "panel" });
    for (const presentation of /** @type {const} */ (["hidden", "docked", "expanded"])) {
      assert.deepEqual(effectiveBrowserViewport(panelTab, presentation), { mode: "panel" });
    }
  });

  it("lets an explicit responsive preset win over Peek's desktop default", () => {
    const phone = { mode: "responsive", width: 390, height: 844, deviceScaleFactor: 3 };
    assert.deepEqual(effectiveBrowserViewport(phone, "peek"), phone);
    assert.notDeepEqual(effectiveBrowserViewport(phone, "peek"), BROWSER_PEEK_VIEWPORT);
  });

  it("plans a Peek of a panel tab as a real emulated desktop frame", () => {
    const bounds = { x: 0, y: 0, width: 420, height: 263 };
    const plan = resolveViewportPlan({
      viewport: effectiveBrowserViewport({ mode: "panel" }, "peek"),
      zoom: { mode: "fit" },
      panelBounds: bounds,
    });

    assert.equal(plan.emulation?.width, 1280);
    assert.equal(plan.emulation?.height, 800);
    assert.ok((plan.emulation?.scale ?? 1) < 0.35, "a small card scales the desktop viewport down");
  });
});

function createRecordingController() {
  const commands = [];
  const bounds = [];
  const released = [];
  const controller = createViewportController({
    sendCommand: async (tabId, method, params) => {
      commands.push({ tabId, method, params });
    },
    setBounds: (tabId, nextBounds) => {
      bounds.push({ tabId, bounds: nextBounds });
    },
    release: (tabId) => {
      released.push(tabId);
    },
  });
  return { controller, commands, bounds, released };
}

describe("durable browser tab state", () => {
  it("starts in panel mode with no emulation and no agent control", () => {
    const state = createBrowserTabRuntimeState("tab_a");

    assert.deepEqual(state, {
      tabId: "tab_a",
      viewport: { mode: "panel" },
      zoom: { mode: "fit" },
      pan: { x: 0, y: 0 },
      pageState: { status: "idle" },
      agentState: { status: "detached" },
      appliedViewport: null,
      appliedBounds: null,
    });
  });

  it("page health is independent of agent health", () => {
    assert.deepEqual(transitionPageState({ status: "idle" }, "start"), { status: "loading" });
    assert.deepEqual(transitionPageState({ status: "loading" }, "stop"), { status: "ready" });

    const failed = transitionPageState({ status: "loading" }, "fail", {
      code: -102,
      description: "ERR_CONNECTION_REFUSED",
      url: "http://localhost:3000",
    });
    assert.equal(failed.status, "error");
    assert.equal(failed.error?.description, "ERR_CONNECTION_REFUSED");

    // A failed load still ends, but the page stays in the error domain.
    assert.deepEqual(transitionPageState(failed, "stop"), failed);
  });
});

describe("viewport plans", () => {
  it("panel mode keeps the panel as the page viewport", () => {
    const plan = resolveViewportPlan({
      viewport: { mode: "panel" },
      zoom: { mode: "fit" },
      panelBounds: { x: 12, y: 40, width: 900, height: 920 },
    });

    assert.deepEqual(plan, {
      bounds: { x: 12, y: 40, width: 900, height: 920 },
      pan: { x: 0, y: 0 },
      overflow: { x: 0, y: 0 },
      emulation: null,
    });
  });

  it("responsive mode pins the virtual viewport and only rescales on panel resize", () => {
    const wide = resolveViewportPlan({
      viewport: RESPONSIVE_1440,
      zoom: { mode: "fit" },
      panelBounds: { x: 0, y: 0, width: 900, height: 920 },
    });
    const narrow = resolveViewportPlan({
      viewport: RESPONSIVE_1440,
      zoom: { mode: "fit" },
      panelBounds: { x: 0, y: 0, width: 600, height: 920 },
    });

    assert.equal(wide.emulation?.width, 1440);
    assert.equal(wide.emulation?.height, 900);
    // Fit leaves a letterbox on every side instead of filling the width.
    assert.equal(wide.emulation?.scale, (900 - RESPONSIVE_FRAME_MARGIN_PX * 2) / 1440);

    // The virtual viewport is untouched; only the fit scale changes.
    assert.equal(narrow.emulation?.width, 1440);
    assert.equal(narrow.emulation?.height, 900);
    assert.equal(narrow.emulation?.scale, (600 - RESPONSIVE_FRAME_MARGIN_PX * 2) / 1440);
    assert.deepEqual(narrow.bounds, { x: 0, y: 0, width: 600, height: 920 });
  });

  it("peeks a panel tab through page zoom, not device emulation", () => {
    // A floating card cannot clip a native surface, so Peek must not hand the
    // page a screen of its own: `fill` did that and the page spilled over the
    // whole app. Zooming keeps the same 1280px layout inside the card.
    assert.equal(browserPeekLayoutZoom({ x: 0, y: 0, width: 440, height: 275 }), 440 / 1280);
    assert.equal(browserPeekLayoutZoom({ x: 0, y: 0, width: 420, height: 560 }), 420 / 1280);
    // A card that has not been measured yet renders at 100%, never at 0%.
    assert.equal(browserPeekLayoutZoom(null), 1);
    assert.equal(browserPeekLayoutZoom({ width: 0, height: 0 }), 1);

    // That path plans no emulation at all — `emulation: null` means "the page
    // viewport is the view", which is exactly what contains the page.
    const bounds = { x: 685, y: 93, width: 440, height: 275 };
    const plan = resolveViewportPlan({
      viewport: { mode: "panel" },
      zoom: { mode: "custom", scale: browserPeekLayoutZoom(bounds) },
      panelBounds: bounds,
    });
    assert.equal(plan.emulation, null);
    assert.deepEqual(plan.bounds, bounds);
    assert.deepEqual(plan.overflow, { x: 0, y: 0 });
    // …and the zoom is what the page is really rendered at.
    assert.equal(
      resolvePageZoomFactor({ mode: "custom", scale: 440 / 1280 }, { mode: "panel" }),
      440 / 1280,
    );
    // The 34% zoom of a 440px card lays a desktop page out at 1280×800, so the
    // page fills the card and the card is the page.
    assert.equal(440 / (440 / 1280), 1280);
    assert.equal(275 / (440 / 1280), 800);
  });

  it("keeps the fitted device frame inside the panel on every edge", () => {
    const bounds = { x: 0, y: 0, width: 900, height: 920 };
    const plan = resolveViewportPlan({ viewport: RESPONSIVE_1440, zoom: { mode: "fit" }, panelBounds: bounds });
    const scale = plan.emulation?.scale ?? 0;
    const offsetX = (plan.emulation?.positionX ?? 0) * scale;
    const offsetY = (plan.emulation?.positionY ?? 0) * scale;
    const frameWidth = 1440 * scale;
    const frameHeight = 900 * scale;

    // The frame can never touch the panel edge it used to run into.
    assert.ok(offsetX >= RESPONSIVE_FRAME_MARGIN_PX - 1, `left letterbox was ${offsetX}`);
    assert.ok(offsetY >= RESPONSIVE_FRAME_MARGIN_PX - 1, `top letterbox was ${offsetY}`);
    assert.ok(bounds.width - (offsetX + frameWidth) >= RESPONSIVE_FRAME_MARGIN_PX - 1, "right letterbox");
    assert.ok(bounds.height - (offsetY + frameHeight) >= RESPONSIVE_FRAME_MARGIN_PX - 1, "bottom letterbox");
    // A fitted frame never overflows, so there is nothing to pan.
    assert.deepEqual(plan.overflow, { x: 0, y: 0 });
  });

  it("actual size renders 1:1 and custom zoom overrides the fit scale", () => {
    const panelBounds = { x: 0, y: 0, width: 900, height: 920 };

    assert.equal(resolveViewportScale({ viewport: RESPONSIVE_1440, zoom: { mode: "actual" }, bounds: panelBounds }), 1);
    assert.equal(
      resolveViewportScale({ viewport: RESPONSIVE_1440, zoom: { mode: "custom", scale: 0.5 }, bounds: panelBounds }),
      0.5,
    );
    assert.equal(resolvePageZoomFactor({ mode: "custom", scale: 1.5 }), 1.5);
    assert.equal(resolvePageZoomFactor({ mode: "fit" }), 1);
    // Responsive zoom is applied as emulation scale, not page zoom.
    assert.equal(resolvePageZoomFactor({ mode: "custom", scale: 1.5 }, RESPONSIVE_1440), 1);
  });

  it("falls back to the panel viewport when the panel has no size yet", () => {
    const plan = resolveViewportPlan({ viewport: RESPONSIVE_1440, zoom: { mode: "fit" }, panelBounds: null });

    assert.deepEqual(plan, {
      bounds: null,
      pan: { x: 0, y: 0 },
      overflow: { x: 0, y: 0 },
      emulation: null,
    });
  });
});

describe("overflowing viewports", () => {
  const NARROW_PANEL = { x: 0, y: 0, width: 700, height: 500 };

  it("actual size overflows the canvas without shrinking the page, and keeps the frame on screen", () => {
    const atOrigin = resolveViewportPlan({
      viewport: RESPONSIVE_1440,
      zoom: { mode: "actual" },
      panelBounds: NARROW_PANEL,
    });

    // 1440x900 at 1:1 inside a 700x500 canvas: the viewport is untouched and the
    // overflow is what the user can pan through.
    assert.equal(atOrigin.emulation?.width, 1440);
    assert.equal(atOrigin.emulation?.height, 900);
    assert.equal(atOrigin.emulation?.scale, 1);
    assert.deepEqual(atOrigin.overflow, { x: 740, y: 400 });
    assert.deepEqual(atOrigin.pan, { x: 0, y: 0 });
    assert.equal(atOrigin.emulation?.positionX, 0);
    assert.equal(atOrigin.emulation?.positionY, 0);

    const panned = resolveViewportPlan({
      viewport: RESPONSIVE_1440,
      zoom: { mode: "actual" },
      panelBounds: NARROW_PANEL,
      pan: { x: 200, y: 120 },
    });

    assert.deepEqual(panned.pan, { x: 200, y: 120 });
    // Chromium requires the emulated view's origin to be *on* its screen
    // (`0 ≤ position ≤ screen`), so the pan is tab state and the origin stays at
    // the screen's edge. A negative position is rejected outright, and rejecting
    // it rejects the whole override with it.
    assert.equal(panned.emulation?.positionX, 0);
    assert.equal(panned.emulation?.positionY, 0);
    assert.equal(panned.emulation?.scale, 1);

    const beyondTheEnd = resolveViewportPlan({
      viewport: RESPONSIVE_1440,
      zoom: { mode: "actual" },
      panelBounds: NARROW_PANEL,
      pan: { x: 10_000, y: 10_000 },
    });

    assert.deepEqual(beyondTheEnd.pan, { x: 740, y: 400 });
    assert.equal(beyondTheEnd.emulation?.positionX, 0);
    assert.equal(beyondTheEnd.emulation?.positionY, 0);
  });

  it("keeps the emulated frame on its own screen for every panel and viewport", () => {
    // Regression: `fit` bottoms out at MIN_ZOOM_VALUE, so a narrow panel fitted
    // the frame in *emulated* px while the screen was reported in native device
    // px — the frame landed past the end of a screen reported several times too
    // small. Chromium answered "View position should be on the screen" and
    // rejected the entire override, so no emulation applied at all and the page
    // fell back to panel-width layout. Expanding the browser resizes the panel,
    // which is exactly when the canvas is briefly narrow, so the page came back
    // unemulated instead of resized.
    const viewports = [
      RESPONSIVE_1440,
      { mode: "responsive", width: 390, height: 844, deviceScaleFactor: 3 },
      { mode: "responsive", width: 1280, height: 800, deviceScaleFactor: 1 },
    ];
    let checked = 0;

    for (let width = 48; width <= 1710; width += 2) {
      for (const height of [120, 500, 900]) {
        for (const viewport of viewports) {
          for (const zoom of [{ mode: "fit" }, { mode: "actual" }]) {
            for (const pan of [{ x: 0, y: 0 }, { x: 10_000, y: 10_000 }]) {
              const { emulation } = resolveViewportPlan({
                viewport,
                zoom,
                panelBounds: { x: 0, y: 0, width, height },
                pan,
              });
              if (!emulation) continue;
              checked += 1;
              const where = `${width}x${height} viewport ${viewport.width}x${viewport.height} ${zoom.mode} pan ${pan.x}`;
              assert.ok(emulation.screenWidth >= 1 && emulation.screenHeight >= 1, `empty screen: ${where}`);
              assert.ok(emulation.positionX >= 0 && emulation.positionX <= emulation.screenWidth, `x origin off screen: ${where}`);
              assert.ok(emulation.positionY >= 0 && emulation.positionY <= emulation.screenHeight, `y origin off screen: ${where}`);
            }
          }
        }
      }
    }

    assert.ok(checked > 1000, `expected a real sweep, checked ${checked}`);
  });

  it("a fitted viewport never overflows, so a stale pan cannot nudge it", () => {
    const plan = resolveViewportPlan({
      viewport: RESPONSIVE_1440,
      zoom: { mode: "fit" },
      panelBounds: NARROW_PANEL,
      pan: { x: 300, y: 300 },
    });

    assert.deepEqual(plan.overflow, { x: 0, y: 0 });
    assert.deepEqual(plan.pan, { x: 0, y: 0 });
    // Fitted and therefore centred with a letterbox on both axes; the stale pan
    // is dropped rather than nudging the frame.
    const unpanNudged = resolveViewportPlan({
      viewport: RESPONSIVE_1440,
      zoom: { mode: "fit" },
      panelBounds: NARROW_PANEL,
    });
    assert.equal(plan.emulation?.positionX, unpanNudged.emulation?.positionX);
    assert.equal(plan.emulation?.positionY, unpanNudged.emulation?.positionY);
    assert.ok((plan.emulation?.positionX ?? 0) > 0);
    assert.ok((plan.emulation?.positionY ?? 0) > 0);
  });

  it("reports the viewport to CDP instead of rewriting the tab viewport", async () => {
    const { controller, commands } = createRecordingController();
    const base = {
      tabId: "tab_a",
      viewport: RESPONSIVE_1440,
      zoom: { mode: "actual" },
      panelBounds: NARROW_PANEL,
      force: true,
    };

    await controller.apply(base);
    await controller.apply({ ...base, pan: { x: 350, y: 0 } });

    // The pan cannot reach CDP: it is only expressible as an origin off the
    // screen, which Chromium refuses. It stays tab state.
    assert.deepEqual(commands.map((entry) => entry.params.positionX), [0, 0]);
    assert.deepEqual(commands.map((entry) => entry.params.width), [1440, 1440]);
    assert.deepEqual(commands.map((entry) => entry.params.scale), [1, 1]);
  });
});

describe("viewport controller", () => {
  it("writes emulation only from the tab viewport, and clears it only in panel mode", async () => {
    const { controller, commands, released } = createRecordingController();
    const panelBounds = { x: 0, y: 0, width: 900, height: 920 };

    await controller.apply({ tabId: "tab_a", viewport: RESPONSIVE_1440, zoom: { mode: "fit" }, panelBounds });
    assert.deepEqual(commands.map((entry) => entry.method), ["Emulation.setDeviceMetricsOverride"]);
    assert.equal(commands[0].params.width, 1440);
    assert.deepEqual(released, []);

    await controller.apply({ tabId: "tab_a", viewport: { mode: "panel" }, zoom: { mode: "fit" }, panelBounds });
    assert.deepEqual(commands.map((entry) => entry.method), [
      "Emulation.setDeviceMetricsOverride",
      "Emulation.clearDeviceMetricsOverride",
    ]);
    // Leaving responsive mode hands the page debugger back.
    assert.deepEqual(released, ["tab_a"]);
  });

  it("panel mode alone never attaches a debugger or writes CDP", async () => {
    const { controller, commands, released } = createRecordingController();
    const args = {
      tabId: "tab_a",
      viewport: { mode: "panel" },
      zoom: { mode: "fit" },
      panelBounds: { x: 0, y: 0, width: 900, height: 920 },
    };

    await controller.apply(args);
    await controller.apply({ ...args, force: true });

    assert.deepEqual(commands, []);
    assert.deepEqual(released, []);
  });

  it("deduplicates repeated applies and re-applies after navigation", async () => {
    const { controller, commands, bounds } = createRecordingController();
    const args = {
      tabId: "tab_a",
      viewport: RESPONSIVE_1440,
      zoom: { mode: "fit" },
      panelBounds: { x: 0, y: 0, width: 900, height: 920 },
    };

    await controller.apply(args);
    await controller.apply(args);
    assert.equal(commands.length, 1);

    await controller.apply({ ...args, force: true });
    assert.equal(commands.length, 2);
    assert.equal(bounds.length, 3);
  });
});

describe("agent lease", () => {
  it("keeps viewport and zoom when control is acquired, used, and released", async () => {
    const tab = createBrowserTabRuntimeState("tab_a");
    tab.viewport = RESPONSIVE_1440;
    const before = structuredClone(tab);

    const leases = createAgentLeaseRegistry();
    const { controller, commands, released } = createRecordingController();
    const panelBounds = { x: 0, y: 0, width: 740, height: 920 };

    await controller.apply({ tabId: tab.tabId, viewport: tab.viewport, zoom: tab.zoom, panelBounds });

    const lease = leases.acquire(tab.tabId, { cdpSessionId: "session-1" });
    assert.equal(leases.statusFor(tab.tabId).status, "attached");

    // Agent navigation re-applies the tab's own viewport, never a reset one.
    await controller.apply({ tabId: tab.tabId, viewport: tab.viewport, zoom: tab.zoom, panelBounds, force: true });
    assert.equal(commands.at(-1).params.width, 1440);
    const commandsAfterAgentTurn = commands.length;

    leases.release(lease.leaseId);

    assert.deepEqual(leases.statusFor(tab.tabId), { status: "detached" });
    assert.deepEqual(tab, before);
    assert.equal(controller.appliedEmulation(tab.tabId)?.includes("1440"), true);
    // Detaching must never emit CDP: no reset, no clear, no debugger handover.
    assert.equal(commands.length, commandsAfterAgentTurn);
    assert.equal(commands.some((entry) => entry.method === "Emulation.clearDeviceMetricsOverride"), false);
    assert.deepEqual(released, []);
  });

  it("reports agent failure without touching durable tab state", () => {
    const tab = createBrowserTabRuntimeState("tab_a");
    tab.viewport = RESPONSIVE_1440;
    const before = structuredClone(tab);

    const leases = createAgentLeaseRegistry();
    const lease = leases.acquire(tab.tabId, { cdpSessionId: "session-1" });
    leases.fail(lease.leaseId, new Error("CDP connection closed"));

    const status = leases.statusFor(tab.tabId);
    assert.equal(status.status, "error");
    assert.equal(status.error?.message, "CDP connection closed");
    assert.deepEqual(tab, before);
  });

  it("hands one lease per tab to repeat or resumed callers", () => {
    const leases = createAgentLeaseRegistry();
    const first = leases.acquire("tab_a", { cdpSessionId: "session-1" });
    const second = leases.acquire("tab_a");

    assert.equal(second.leaseId, first.leaseId);
    assert.equal(leases.list().length, 1);

    leases.pause(first.leaseId);
    assert.equal(leases.statusFor("tab_a").status, "paused");
    leases.acquire("tab_a");
    assert.equal(leases.statusFor("tab_a").status, "attached");

    leases.releaseTab("tab_a");
    assert.equal(leases.leaseForTab("tab_a"), null);
    assert.deepEqual(leases.statusFor("tab_a"), { status: "detached" });
  });
});
