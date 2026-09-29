/**
 * The built-in browser's viewport controls, end to end.
 *
 * This closes the responsive-viewport architecture: it drives the *shipped*
 * controls rather than IPC back doors, so the chain under test is
 *
 *   visible control -> renderer store -> IPC -> Electron runtime -> CDP
 *   emulation -> rendered page
 *
 * The fixture page is served from the driver host on 127.0.0.1, so this spec
 * targets the local lane. A Daytona run would need the fixture written into the
 * sandbox and served from there.
 */
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

import { createAndSelectWorkspace, evalIn } from "@sofia/behaviors";
import { connect, debuggerUrlFor, evaluate, targetById } from "@sofia/cdp";
import type { CdpClient, Surface } from "@sofia/cdp";
import { desktop } from "@sofia/hosts";
import { needs, test } from "@sofia/testkit";
import { screenshot, validate } from "@sofia/test-evidence";
import { expect, onTestFinished } from "vitest";

const FIXTURE_PATH = fileURLToPath(new URL("../fixtures/browser-viewport-fixture.html", import.meta.url));
const STEP_TIMEOUT_MS = 30_000;
const POLL_MS = 250;
const PANEL_MATCH_TOLERANCE_PX = 40;

type FixtureFacts = {
  innerWidth: number;
  innerHeight: number;
  dpr: number;
  desktop: boolean;
  tablet: boolean;
  phone: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number") {
    throw new Error(`The viewport fixture did not report a numeric ${key}.`);
  }
  return value;
}

function requireBoolean(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") {
    throw new Error(`The viewport fixture did not report a boolean ${key}.`);
  }
  return value;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function startFixtureServer() {
  const html = await readFile(FIXTURE_PATH, "utf8");
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();

  if (!address || typeof address !== "object") {
    throw new Error("The viewport fixture server did not bind to a port.");
  }

  return {
    url: `http://127.0.0.1:${address.port}/fixture.html`,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); }),
  };
}

/** Attach to one browser tab's own page target, the way an agent would. */
async function attachTab(cdpUrl: string, targetId: string): Promise<Surface> {
  const target = await targetById(cdpUrl, targetId, { timeoutMs: STEP_TIMEOUT_MS });
  const client: CdpClient = await connect(debuggerUrlFor(cdpUrl, target), {
    connectTimeoutMs: STEP_TIMEOUT_MS,
    sendTimeoutMs: STEP_TIMEOUT_MS,
  });
  await client.send("Page.enable", {}, { timeoutMs: STEP_TIMEOUT_MS }).catch(() => undefined);
  return {
    handle: { name: `browser-tab-${targetId}`, kind: "chrome", hostKind: "local", cdpUrl },
    client,
  };
}

async function readFixtureFacts(client: CdpClient): Promise<FixtureFacts> {
  const value = await evaluate(client, `(() => {
    const shown = (id) => {
      const el = document.getElementById(id);
      return Boolean(el) && getComputedStyle(el).display !== "none";
    };
    return {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      dpr: window.devicePixelRatio,
      desktop: shown("desktop"),
      tablet: shown("tablet"),
      phone: shown("phone"),
    };
  })()`, { timeoutMs: 10_000 });

  if (!isRecord(value)) {
    throw new Error(`The viewport fixture returned no facts: ${JSON.stringify(value)}`);
  }

  return {
    innerWidth: requireNumber(value, "innerWidth"),
    innerHeight: requireNumber(value, "innerHeight"),
    dpr: requireNumber(value, "dpr"),
    desktop: requireBoolean(value, "desktop"),
    tablet: requireBoolean(value, "tablet"),
    phone: requireBoolean(value, "phone"),
  };
}

async function waitForFixture(
  client: CdpClient,
  predicate: (facts: FixtureFacts) => boolean,
  label: string,
): Promise<FixtureFacts> {
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  let last: FixtureFacts | null = null;
  let lastError: unknown = null;

  while (Date.now() < deadline) {
    try {
      last = await readFixtureFacts(client);
      if (predicate(last)) return last;
    } catch (error) {
      lastError = error;
    }
    await sleep(POLL_MS);
  }

  throw new Error(
    `The fixture never reached ${label}. Last facts: ${JSON.stringify(last)}` +
    (lastError ? ` (last error: ${String(lastError)})` : ""),
  );
}

/** The runtime's own report of what it applied to one tab. */
async function readTabState(app: Surface, tabId: string): Promise<Record<string, unknown>> {
  const state = await evalIn(app, "window.__SOFIA_ELECTRON__.browser.getState()", {
    awaitPromise: true,
    timeoutMs: STEP_TIMEOUT_MS,
  });

  if (!isRecord(state) || !Array.isArray(state.tabs)) {
    throw new Error(`The app did not report browser tabs: ${JSON.stringify(state)}`);
  }

  const tab = state.tabs.find((entry) => isRecord(entry) && entry.id === tabId);

  if (!isRecord(tab)) {
    throw new Error(`Tab ${tabId} is not in the browser state.`);
  }

  return tab;
}

async function waitForTabState(
  app: Surface,
  tabId: string,
  predicate: (tab: Record<string, unknown>) => boolean,
  label: string,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  let last: Record<string, unknown> = {};

  while (Date.now() < deadline) {
    last = await readTabState(app, tabId);
    if (predicate(last)) return last;
    await sleep(POLL_MS);
  }

  throw new Error(`Tab ${tabId} never reported ${label}. Last: ${JSON.stringify(last)}`);
}

function appliedViewportOf(tab: Record<string, unknown>): Record<string, unknown> | null {
  const applied = tab.appliedViewport;
  return isRecord(applied) ? applied : null;
}

function nestedNumber(record: Record<string, unknown> | null, group: string, key: string): number {
  const nested = record ? record[group] : null;
  if (!isRecord(nested)) return 0;
  const value = nested[key];
  return typeof value === "number" ? value : 0;
}

/** Focus the canvas scrollbar and press a key, the way a keyboard user would. */
async function pressPanKey(app: Surface, orientation: "vertical" | "horizontal", key: string): Promise<boolean> {
  const selector = `[data-testid="browser-pan-thumb-${orientation}"]`;
  const pressed = await evalIn(app, `(() => {
    const thumb = document.querySelector(${JSON.stringify(selector)});
    if (!thumb) return false;
    thumb.focus();
    thumb.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true }));
    return true;
  })()`);

  return pressed === true;
}

/**
 * The page is a native view that CSS cannot clip, so containment is asserted
 * against the rectangle Sofia granted it: native ⊆ canvas. `appliedBounds` is
 * what the runtime actually set on the view; the canvas rect is in CSS pixels,
 * which matches at the 1.0 window zoom the lane uses.
 */
async function assertNativeInsideCanvas(app: Surface, tabId: string, why: string): Promise<void> {
  const canvas = await evalIn(app, `(() => {
    const el = document.querySelector('[data-testid="browser-canvas"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
  })()`);

  if (!isRecord(canvas)) {
    throw new Error(`No browser canvas to check after ${why}`);
  }

  const tab = await waitForTabState(app, tabId, (entry) => isRecord(entry.appliedBounds), `a native rect after ${why}`);
  const native = tab.appliedBounds;

  if (!isRecord(native)) {
    throw new Error(`The runtime reported no native rect after ${why}`);
  }

  const inside =
    Number(native.x) >= Number(canvas.x) - 1 &&
    Number(native.y) >= Number(canvas.y) - 1 &&
    Number(native.x) + Number(native.width) <= Number(canvas.x) + Number(canvas.width) + 1 &&
    Number(native.y) + Number(native.height) <= Number(canvas.y) + Number(canvas.height) + 1;

  expect(
    inside,
    `The native browser surface escaped its canvas after ${why}: native ${JSON.stringify(native)} vs canvas ${JSON.stringify(canvas)}`,
  ).toBe(true);
}

function queryTestIdSelector(testId: string): string {
  return `[data-testid="${testId}"]`;
}

/**
 * Click a control with trusted input.
 *
 * DOM-dispatched events are not enough: Base UI ignores them for opening menus,
 * so a synthetic click would silently do nothing (and a menu that fails to open
 * during render would take the whole app down unnoticed).
 */
async function clickTestId(app: Surface, testId: string): Promise<void> {
  const point = await evalIn(app, `(() => {
    const el = document.querySelector(${JSON.stringify(queryTestIdSelector(testId))});
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
  })()`);

  if (!isRecord(point) || typeof point.x !== "number" || typeof point.y !== "number") {
    throw new Error(`Missing app control ${queryTestIdSelector(testId)}`);
  }

  await app.client.send("Input.dispatchMouseEvent", {
    type: "mouseMoved", x: point.x, y: point.y, button: "none", buttons: 0,
  }, { timeoutMs: STEP_TIMEOUT_MS });
  await app.client.send("Input.dispatchMouseEvent", {
    type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: 1,
  }, { timeoutMs: STEP_TIMEOUT_MS });
  await app.client.send("Input.dispatchMouseEvent", {
    type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: 1,
  }, { timeoutMs: STEP_TIMEOUT_MS });
}

/** Fail fast when a click was supposed to blank the app or leave it in place. */
async function assertAppAlive(app: Surface, why: string): Promise<void> {
  const alive = await evalIn(app, `(() => {
    const root = document.getElementById("root");
    return Boolean(document.querySelector('[data-slot="sidebar"]')) && Boolean(root) && root.childElementCount > 0;
  })()`);
  expect(alive, `The app renderer was empty after ${why}`).toBe(true);
}

async function readTestIdText(app: Surface, testId: string): Promise<string> {
  const text = await evalIn(app, `(() => {
    const el = document.querySelector(${JSON.stringify(queryTestIdSelector(testId))});
    return el ? (el.textContent || "").trim() : null;
  })()`);

  if (typeof text !== "string") {
    throw new Error(`Missing app control ${queryTestIdSelector(testId)}`);
  }

  return text;
}

async function waitForTestIdText(
  app: Surface,
  testId: string,
  predicate: (text: string) => boolean,
  label: string,
): Promise<string> {
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  let last = "";

  while (Date.now() < deadline) {
    last = await readTestIdText(app, testId).catch(() => "");
    if (last && predicate(last)) return last;
    await sleep(POLL_MS);
  }

  throw new Error(`The control ${testId} never satisfied ${label} (last text "${last}").`);
}

async function readPanelWidth(app: Surface): Promise<number> {
  const width = await evalIn(app, `(() => {
    const el = document.querySelector('[data-testid="browser-canvas"]');
    return el ? Math.round(el.getBoundingClientRect().width) : 0;
  })()`);

  if (typeof width !== "number" || width <= 0) {
    throw new Error("The browser panel content is not measurable in the app window.");
  }

  return width;
}

async function waitForPanelWidth(
  app: Surface,
  predicate: (width: number) => boolean,
  label: string,
): Promise<number> {
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  let last = 0;

  while (Date.now() < deadline) {
    last = await readPanelWidth(app);
    if (predicate(last)) return last;
    await sleep(POLL_MS);
  }

  throw new Error(`The browser panel never reached ${label} (last width ${last}px).`);
}

/**
 * Drag the panel divider: the physical half of "resize the browser pane".
 *
 * Fails loudly when the gesture does not move the panel, because a silent no-op
 * here would make every downstream viewport assertion meaningless.
 */
async function dragBrowserPanelTo(app: Surface, targetWidth: number): Promise<void> {
  const before = await readPanelWidth(app);

  const divider = await evalIn(app, `(() => {
    const divider = document.querySelector('[data-slot="resizable-handle"][aria-orientation="vertical"]');
    if (!divider) return {
      ok: false,
      reason: "there is no panel divider in this layout",
      presentation: document.querySelector('[data-browser-presentation]')?.getAttribute('data-browser-presentation'),
      canvasCount: document.querySelectorAll('[data-testid="browser-canvas"]').length,
      railPressed: document.querySelector('button[aria-label="Browser"]')?.getAttribute('aria-pressed'),
      handles: Array.from(document.querySelectorAll('[data-slot="resizable-handle"]')).map((element) => element.outerHTML.slice(0, 500)),
    };

    const rect = divider.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      return { ok: false, reason: "the panel divider is not visible at this window width" };
    }

    return { ok: true, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);

  if (!isRecord(divider) || divider.ok === false || typeof divider.x !== "number" || typeof divider.y !== "number") {
    throw new Error(`Could not drag the panel divider: ${JSON.stringify(divider)}`);
  }

  // The browser panel is on the right: moving its left divider right narrows
  // it. Trusted input also exercises the real pointer-capture path.
  const endX = divider.x + before - targetWidth;
  await app.client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: divider.x, y: divider.y, button: "none", buttons: 0 });
  await app.client.send("Input.dispatchMouseEvent", { type: "mousePressed", x: divider.x, y: divider.y, button: "left", buttons: 1, clickCount: 1 });
  for (let step = 1; step <= 12; step += 1) {
    await app.client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: divider.x + (endX - divider.x) * step / 12, y: divider.y, button: "left", buttons: 1 });
  }
  await app.client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: endX, y: divider.y, button: "left", buttons: 0, clickCount: 1 });

  await waitForPanelWidth(
    app,
    (width) => Math.abs(width - before) >= 40,
    `a width different from ${before}px after a divider drag`,
  );
}

test("the shipped viewport controls pin a virtual viewport through resize, agent control, and tab switches", { timeout: 10 * 60_000 }, async ({ evidence, skip }) => {
  needs({ optIn: ["SOFIA_EVAL_E2E_TESTS"] });

  await using app = await desktop({ name: "browser-viewport-controls" });

  if (app.handle.hostKind !== "local") {
    skip("the viewport fixture is served from the driver host, so this spec runs on the local lane");
  }

  const fixture = await startFixtureServer();
  onTestFinished(() => fixture.close());

  await createAndSelectWorkspace(app, { path: `/tmp/sofia-browser-viewport-${Date.now()}` });

  // The first-run flow may leave the model picker open over the task surface.
  // Native browser views correctly stay hidden behind dialogs, so close it
  // before checking browser geometry.
  const modelPickerOpen = await evalIn(app, `Boolean(Array.from(document.querySelectorAll('[role="dialog"]')).find((dialog) => dialog.textContent?.includes('Select a model for this session.')))`);
  if (modelPickerOpen) {
    await app.client.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await app.client.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  }

  const openFixtureTab = async (): Promise<{ tabId: string; surface: Surface }> => {
    const opened = await evalIn(
      app,
      `window.__SOFIA_ELECTRON__.browser.openUrl(${JSON.stringify(fixture.url)}, "builtin")`,
      { awaitPromise: true, timeoutMs: STEP_TIMEOUT_MS },
    );

    if (!isRecord(opened) || typeof opened.target_id !== "string" || typeof opened.tab_id !== "string") {
      throw new Error(`Opening the fixture returned no CDP handle: ${JSON.stringify(opened)}`);
    }

    return { tabId: opened.tab_id, surface: await attachTab(app.handle.cdpUrl, opened.target_id) };
  };

  // 1. Default is Panel: the page viewport follows the physical panel.
  const first = await openFixtureTab();
  await using firstSurface = { async [Symbol.asyncDispose]() { first.surface.client.close(); } };

  // Agent-opened pages appear in Peek first. Dock through the same browser
  // rail button a person uses before asserting panel-sized viewport behavior.
  const dockDeadline = Date.now() + STEP_TIMEOUT_MS;
  while (Date.now() < dockDeadline) {
    const opened = await evalIn(app, `(() => {
      const button = document.querySelector('button[aria-label="Browser"]');
      if (!button) return false;
      button.click();
      return true;
    })()`);
    if (opened) break;
    await sleep(POLL_MS);
  }

  const initialPanelWidth = await readPanelWidth(app);
  const panelMode = await waitForFixture(
    first.surface.client,
    (facts) => facts.innerWidth > 200 && facts.innerWidth < 1440,
    "a panel-sized viewport in panel mode",
  );
  await assertNativeInsideCanvas(app, first.tabId, "opening the panel");
  const panelMatchesContent = Math.abs(panelMode.innerWidth - initialPanelWidth) < PANEL_MATCH_TOLERANCE_PX;
  expect(panelMatchesContent).toBe(true);
  expect(panelMode.desktop).toBe(false);
  evidence.recordAssertionEvidence(
    "Panel mode follows the physical panel width",
    `The fixture reported innerWidth ${panelMode.innerWidth} while the panel content measured ${initialPanelWidth}px, and the >=1200 media query stayed hidden.`,
    panelMatchesContent && !panelMode.desktop,
  );

  // 2. Choosing a preset through the real control starts a virtual viewport.
  await clickTestId(app, "browser-viewport-trigger");
  await assertAppAlive(app, "opening the viewport menu");
  await clickTestId(app, "browser-viewport-option-desktop");
  await assertAppAlive(app, "choosing the Desktop preset");

  const desktopFacts = await waitForFixture(
    first.surface.client,
    (facts) => facts.innerWidth === 1440,
    "the Desktop 1440x900 viewport",
  );
  expect(desktopFacts.innerHeight).toBe(900);
  expect(desktopFacts.desktop).toBe(true);
  expect(desktopFacts.tablet).toBe(false);
  evidence.recordAssertionEvidence(
    "Choosing the Desktop preset gives the page a 1440x900 viewport",
    `The fixture reported ${desktopFacts.innerWidth}x${desktopFacts.innerHeight} at dpr ${desktopFacts.dpr}, with the >=1200 media query visible and the <=768 query hidden.`,
    desktopFacts.innerWidth === 1440 && desktopFacts.innerHeight === 900 && desktopFacts.desktop && !desktopFacts.tablet,
  );

  await assertNativeInsideCanvas(app, first.tabId, "choosing the Desktop preset");
  const wideShot = await screenshot(first.surface);
  const wideSeen = await validate(wideShot, [
    "A monospace diagnostic page shows innerWidth 1440 and innerHeight 900",
    "A green 'desktop >= 1200' badge is visible and no tablet/phone badge is",
  ]);
  expect(wideSeen.ok, wideSeen.why).toBe(true);

  const chromeShot = await screenshot(app);
  const chromeSeen = await validate(chromeShot, [
    "The browser panel toolbar is visible and compact",
    "A secondary row shows a Responsive label with 1440 x 900 and a Fit zoom readout",
  ]);
  expect(chromeSeen.ok, chromeSeen.why).toBe(true);

  // 3. Resizing the panel rescales the virtual viewport instead of rewriting it.
  const fitBefore = await readTestIdText(app, "browser-zoom-trigger");
  await dragBrowserPanelTo(app, initialPanelWidth - 200);
  const narrowedPanelWidth = await waitForPanelWidth(
    app,
    (width) => width < initialPanelWidth - PANEL_MATCH_TOLERANCE_PX,
    "a narrower panel after the divider drag",
  );

  const afterResize = await waitForFixture(
    first.surface.client,
    (facts) => facts.innerWidth === 1440,
    "the same 1440px viewport after a panel resize",
  );
  expect(afterResize.innerHeight).toBe(900);
  const fitAfter = await waitForTestIdText(
    app,
    "browser-zoom-trigger",
    (text) => text !== fitBefore,
    `a fit readout different from "${fitBefore}"`,
  );
  evidence.recordAssertionEvidence(
    "Resizing the panel changes the fit scale, never the virtual viewport",
    `The panel went ${initialPanelWidth}px -> ${narrowedPanelWidth}px while the fixture stayed ${afterResize.innerWidth}x${afterResize.innerHeight}; the zoom readout moved "${fitBefore}" -> "${fitAfter}".`,
    afterResize.innerWidth === 1440 && afterResize.innerHeight === 900 && fitAfter !== fitBefore,
  );

  await assertNativeInsideCanvas(app, first.tabId, "resizing the panel");
  const narrowShot = await screenshot(first.surface);
  const narrowSeen = await validate(narrowShot, [
    "The diagnostic page still reports innerWidth 1440 on a visibly narrower panel",
    "The green 'desktop >= 1200' badge is still visible",
  ]);
  expect(narrowSeen.ok, narrowSeen.why).toBe(true);

  // 4. Actual size, and a custom scale, overflow the canvas instead of
  //    squeezing the page: the browser becomes pannable, the viewport does not
  //    change. This is the one behaviour that cannot be faked by resizing.
  await clickTestId(app, "browser-zoom-trigger");
  await assertAppAlive(app, "opening the zoom menu");
  await clickTestId(app, "browser-zoom-option-actual");
  await assertAppAlive(app, "choosing Actual size");

  const actualSize = await waitForTabState(
    app,
    first.tabId,
    (tab) => {
      const applied = appliedViewportOf(tab);
      return applied !== null && nestedNumber(applied, "overflow", "y") > 0;
    },
    "an overflowing canvas at actual size",
  );
  const actualApplied = appliedViewportOf(actualSize);
  const actualOverflowY = nestedNumber(actualApplied, "overflow", "y");
  expect(actualOverflowY).toBeGreaterThan(0);

  const stillFullSize = await waitForFixture(
    first.surface.client,
    (facts) => facts.innerWidth === 1440,
    "the unchanged 1440px viewport at actual size",
  );
  expect(stillFullSize.innerHeight).toBe(900);
  expect(stillFullSize.desktop).toBe(true);

  // Actual size overflows both axes, so the reserved pan strips must already be
  // excluded from the native rect: it has to be strictly smaller than the canvas.
  await assertNativeInsideCanvas(app, first.tabId, "choosing Actual size");
  const overflowCanvas = await evalIn(app, `(() => {
    const el = document.querySelector('[data-testid="browser-canvas"]');
    const r = el.getBoundingClientRect();
    return { width: Math.round(r.width), height: Math.round(r.height) };
  })()`);
  const overflowNative = (await waitForTabState(app, first.tabId, (entry) => isRecord(entry.appliedBounds), "a native rect at actual size")).appliedBounds;
  if (isRecord(overflowCanvas) && isRecord(overflowNative)) {
    expect(Number(overflowNative.width), "the vertical pan strip must be reserved outside the native rect").toBeLessThan(Number(overflowCanvas.width));
    expect(Number(overflowNative.height), "the horizontal pan strip must be reserved outside the native rect").toBeLessThan(Number(overflowCanvas.height));
  }

  const pressed = await pressPanKey(app, "vertical", "ArrowDown");
  expect(pressed, "the browser canvas should expose a vertical scrollbar at actual size").toBe(true);

  const panned = await waitForTabState(
    app,
    first.tabId,
    (tab) => {
      const applied = appliedViewportOf(tab);
      return applied !== null && nestedNumber(applied, "pan", "y") > 0;
    },
    "a panned canvas",
  );
  const pannedApplied = appliedViewportOf(panned);
  const pannedBy = nestedNumber(pannedApplied, "pan", "y");
  const stillPinned = await readFixtureFacts(first.surface.client);
  expect(stillPinned.innerWidth).toBe(1440);
  expect(stillPinned.innerHeight).toBe(900);
  evidence.recordAssertionEvidence(
    "Actual size pans the canvas instead of squeezing the page",
    `The runtime reported ${actualOverflowY}px of vertical overflow; a keyboard pan moved the canvas ${pannedBy}px while the fixture stayed ${stillPinned.innerWidth}x${stillPinned.innerHeight}.`,
    actualOverflowY > 0 && pannedBy > 0 && stillPinned.innerWidth === 1440 && stillPinned.innerHeight === 900,
  );

  // Back to Fit: a fitted viewport never overflows, so the canvas cannot stay
  // scrolled and the scrollbar should disappear.
  await clickTestId(app, "browser-zoom-trigger");
  await clickTestId(app, "browser-zoom-option-fit");
  const fitted = await waitForTabState(
    app,
    first.tabId,
    (tab) => {
      const applied = appliedViewportOf(tab);
      return applied !== null && nestedNumber(applied, "overflow", "y") === 0 && nestedNumber(applied, "pan", "y") === 0;
    },
    "a fitted, unscrolled canvas",
  );
  expect(nestedNumber(appliedViewportOf(fitted), "overflow", "y")).toBe(0);
  evidence.recordAssertionEvidence(
    "Fit clears the scroll once the canvas fits again",
    `After returning to Fit the runtime reported overflow ${nestedNumber(appliedViewportOf(fitted), "overflow", "y")}px and pan ${nestedNumber(appliedViewportOf(fitted), "pan", "y")}px.`,
    nestedNumber(appliedViewportOf(fitted), "overflow", "y") === 0 && nestedNumber(appliedViewportOf(fitted), "pan", "y") === 0,
  );

  // 5. An agent lease must not disturb the viewport in either direction.
  await evalIn(
    app,
    `window.__SOFIA_ELECTRON__.browser.agentLease("acquire", { tabId: ${JSON.stringify(first.tabId)} })`,
    { awaitPromise: true, timeoutMs: STEP_TIMEOUT_MS },
  );
  const whileLeased = await readFixtureFacts(first.surface.client);
  await evalIn(
    app,
    `window.__SOFIA_ELECTRON__.browser.agentLease("release", { tabId: ${JSON.stringify(first.tabId)} })`,
    { awaitPromise: true, timeoutMs: STEP_TIMEOUT_MS },
  );
  const afterLease = await readFixtureFacts(first.surface.client);
  evidence.recordAssertionEvidence(
    "Acquiring and releasing agent control leaves the viewport untouched",
    `Attached: ${whileLeased.innerWidth}x${whileLeased.innerHeight}. Detached: ${afterLease.innerWidth}x${afterLease.innerHeight}.`,
    whileLeased.innerWidth === 1440 && afterLease.innerWidth === 1440 && afterLease.innerHeight === 900,
  );

  // 6. A second tab keeps its own viewport; the first tab keeps its own too.
  const second = await openFixtureTab();
  await using secondSurface = { async [Symbol.asyncDispose]() { second.surface.client.close(); } };

  await waitForFixture(second.surface.client, (facts) => facts.innerWidth > 200, "the second fixture tab to load");
  await clickTestId(app, "browser-viewport-trigger");
  await assertAppAlive(app, "opening the viewport menu on the second tab");
  await clickTestId(app, "browser-viewport-option-phone");
  await assertAppAlive(app, "choosing the Phone preset");

  const phoneFacts = await waitForFixture(
    second.surface.client,
    (facts) => facts.innerWidth === 390,
    "the Phone 390x844 viewport on the second tab",
  );
  expect(phoneFacts.innerHeight).toBe(844);
  expect(phoneFacts.tablet).toBe(true);
  expect(phoneFacts.desktop).toBe(false);
  evidence.recordAssertionEvidence(
    "A second tab holds an independent Phone viewport",
    `The second tab reported ${phoneFacts.innerWidth}x${phoneFacts.innerHeight} with the <=768 media query visible.`,
    phoneFacts.innerWidth === 390 && phoneFacts.innerHeight === 844 && phoneFacts.tablet,
  );

  await assertNativeInsideCanvas(app, second.tabId, "switching to the Phone preset on a second tab");
  const phoneShot = await screenshot(second.surface);
  const phoneSeen = await validate(phoneShot, [
    "A monospace diagnostic page shows innerWidth 390 and innerHeight 844",
    "An amber 'tablet <= 768' badge is visible and the desktop badge is not",
  ]);
  expect(phoneSeen.ok, phoneSeen.why).toBe(true);

  await clickTestId(app, `panel-tab-${first.tabId}`);
  const restored = await waitForFixture(
    first.surface.client,
    (facts) => facts.innerWidth === 1440,
    "the first tab's own viewport after switching back",
  );
  const untouchedSecond = await readFixtureFacts(second.surface.client);
  evidence.recordAssertionEvidence(
    "Switching tabs restores each tab's own viewport",
    `The first tab came back at ${restored.innerWidth}x${restored.innerHeight} while the second tab stayed at ${untouchedSecond.innerWidth}x${untouchedSecond.innerHeight}.`,
    restored.innerWidth === 1440 && restored.innerHeight === 900 && untouchedSecond.innerWidth === 390,
  );

  // 7. Returning to Panel mode makes the panel the viewport authority again.
  await clickTestId(app, "browser-viewport-trigger");
  await assertAppAlive(app, "opening the viewport menu to leave responsive mode");
  await clickTestId(app, "browser-viewport-option-panel");
  await assertAppAlive(app, "choosing Panel");
  await waitForFixture(
    first.surface.client,
    (facts) => facts.innerWidth < 1440,
    "the panel-sized viewport after leaving responsive mode",
  );
  const backToPanel = await readFixtureFacts(first.surface.client);
  const finalPanelWidth = await readPanelWidth(app);
  const returnedToPanel = Math.abs(backToPanel.innerWidth - finalPanelWidth) < PANEL_MATCH_TOLERANCE_PX;
  expect(returnedToPanel).toBe(true);
  evidence.recordAssertionEvidence(
    "Leaving responsive mode returns the page to the panel viewport",
    `The fixture went back to innerWidth ${backToPanel.innerWidth} against a ${finalPanelWidth}px panel.`,
    returnedToPanel,
  );
});
