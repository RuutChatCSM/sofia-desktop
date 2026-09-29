import { createServer } from "node:http";

import { createAndSelectWorkspace, evalIn } from "@sofia/behaviors";
import { connect, debuggerUrlFor, evaluate, listTargets } from "@sofia/cdp";
import { desktop } from "@sofia/hosts";
import { needs, test } from "@sofia/testkit";
import { expect, onTestFinished } from "vitest";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("browser controls open native menus and find on the live page", { timeout: 5 * 60_000 }, async ({ evidence, skip }) => {
  needs({ optIn: ["SOFIA_EVAL_E2E_TESTS"] });
  await using app = await desktop({ name: "browser-toolbar-menu" });
  if (app.handle.hostKind !== "local") skip("the fixture runs on the local driver host");

  const fixture = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>Browser controls</title><body><p>Distinctive browser search phrase</p></body>");
  });
  await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  onTestFinished(() => fixture.close());
  const address = fixture.address();
  if (!address || typeof address === "string") throw new Error("Fixture did not bind");

  await createAndSelectWorkspace(app, { path: `/tmp/sofia-browser-menu-${Date.now()}` });
  const pickerOpen = await evalIn(app, `Boolean(Array.from(document.querySelectorAll('[role="dialog"]')).find((dialog) => dialog.textContent?.includes('Select a model for this session.')))`);
  if (pickerOpen) {
    await app.client.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await app.client.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  }
  await evalIn(app, `window.__SOFIA_ELECTRON__.browser.openUrl("http://127.0.0.1:${address.port}/", "builtin")`, { awaitPromise: true });

  for (let attempt = 0; attempt < 60; attempt += 1) {
    const docked = await evalIn(app, `(() => {
      const button = document.querySelector('button[aria-label="Browser"]');
      if (!button) return false;
      button.click();
      return Boolean(document.querySelector('[data-testid="browser-menu-trigger"]'));
    })()`);
    if (docked) break;
    await sleep(250);
  }
  expect(await evalIn(app, `Boolean(document.querySelector('[data-testid="browser-menu-trigger"]'))`)).toBe(true);

  const clickControl = async (testId: string) => {
    const clicked = await evalIn(app, `(() => {
      const button = document.querySelector('[data-testid="${testId}"]');
      if (!button) return false;
      button.click();
      return true;
    })()`);
    expect(clicked).toBe(true);
  };

  await clickControl("browser-menu-trigger");
  let overlayTarget;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    overlayTarget = (await listTargets(app.handle.cdpUrl)).find((target) => target.url.endsWith("/overlay.html") && target.webSocketDebuggerUrl);
    if (overlayTarget) break;
    await sleep(250);
  }
  if (!overlayTarget) throw new Error("Browser menu native overlay did not open");
  const overlay = await connect(debuggerUrlFor(app.handle.cdpUrl, overlayTarget));
  onTestFinished(() => overlay.close());

  let menuText = "";
  for (let attempt = 0; attempt < 80; attempt += 1) {
    menuText = String(await evaluate(overlay, `document.body?.innerText ?? "loading"`).catch(() => "loading"));
    if (menuText.includes("Find in page")) break;
    await sleep(250);
  }
  expect(menuText, `overlay URL: ${overlayTarget.url}`).toContain("Find in page");
  expect(menuText).toContain("Extensions");
  expect(menuText).toContain("Take a screenshot");
  await evaluate(overlay, `document.querySelector('[aria-label="browser context menu"] button')?.click()`);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await evalIn(app, `Boolean(document.querySelector('[data-testid="browser-find-input"]'))`)) break;
    await sleep(250);
  }
  expect(await evalIn(app, `Boolean(document.querySelector('[data-testid="browser-find-input"]'))`)).toBe(true);
  evidence.recordAssertionEvidence("Browser menu opens an actionable find control", "The native overlay listed browser actions and its Find action opened Sofia's in-page search field.", true);

  await clickControl("browser-extensions-trigger");
  let extensionText = "";
  for (let attempt = 0; attempt < 80; attempt += 1) {
    extensionText = String(await evaluate(overlay, `document.body?.innerText ?? "loading"`).catch(() => "loading"));
    if (extensionText.includes("Load unpacked extension")) break;
    await sleep(250);
  }
  expect(extensionText).toContain("Load unpacked extension");
  evidence.recordAssertionEvidence("Extensions have a supported install entry point", "The browser extensions control offers loading an unpacked directory into the persistent Electron browser session.", true);

  await clickControl("browser-menu-trigger");
  for (let attempt = 0; attempt < 40; attempt += 1) {
    menuText = String(await evaluate(overlay, `document.body?.innerText ?? "loading"`).catch(() => "loading"));
    if (menuText.includes("Find in page")) break;
    await sleep(250);
  }
  expect(menuText).toContain("Zoom");
  await evaluate(overlay, `Array.from(document.querySelectorAll('[aria-label="browser context menu"] button')).find((button) => button.textContent?.trim() === 'Zoom')?.click()`);
  let zoomText = "";
  for (let attempt = 0; attempt < 40; attempt += 1) {
    zoomText = String(await evaluate(overlay, `document.body?.innerText ?? "loading"`).catch(() => "loading"));
    if (zoomText.includes("Zoom in")) break;
    await sleep(250);
  }
  expect(zoomText).toContain("Zoom in");
  await evaluate(overlay, `Array.from(document.querySelectorAll('[aria-label="zoom context menu"] button')).find((button) => button.textContent?.trim() === 'Zoom in')?.click()`);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const zoomed = await evalIn(app, `window.__SOFIA_ELECTRON__.browser.getState().then((state) => state.tabs.some((tab) => tab.zoom?.scale === 1.25))`, { awaitPromise: true });
    if (zoomed) {
      evidence.recordAssertionEvidence("Menu zoom changes browser state", "Selecting Zoom in from the native browser menu set the active tab zoom to 125%.", true);
      break;
    }
    if (attempt === 39) throw new Error("Zoom in menu action did not update the browser tab");
    await sleep(250);
  }

  const avatarPoint = await evalIn(app, `(() => {
    const button = document.querySelector('[data-testid="account-status-menu"]');
    if (!button) return null;
    const rect = button.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  if (!avatarPoint || typeof avatarPoint !== "object" || !("x" in avatarPoint) || !("y" in avatarPoint)) throw new Error("Account menu trigger missing");
  const x = Number(avatarPoint.x);
  const y = Number(avatarPoint.y);
  await app.client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0 });
  await app.client.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
  await app.client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const menuOpen = await evalIn(app, `Boolean(document.querySelector('[data-slot="dropdown-menu-content"]'))`);
    if (menuOpen) break;
    await sleep(250);
  }
  expect(await evalIn(app, `Boolean(document.querySelector('[data-slot="dropdown-menu-content"]'))`)).toBe(true);
  expect(await evalIn(app, `window.__SOFIA_ELECTRON__.browser.getState().then((state) => state.viewVisible)`, { awaitPromise: true })).toBe(true);
  evidence.recordAssertionEvidence("Footer account menu keeps the browser page mounted", "Opening the sidebar account menu left the native browser surface visible in its separate right-hand panel.", true);

  await app.client.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await app.client.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  const panelWidth = await evalIn(app, `document.querySelector('[data-testid="browser-panel-shell"]')?.getBoundingClientRect().width`);
  await clickControl("side-panel-expand");
  let expandedWidth = 0;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    expandedWidth = Number(await evalIn(app, `document.querySelector('[data-testid="browser-panel-shell"]')?.getBoundingClientRect().width`));
    if (expandedWidth > Number(panelWidth) + 150) break;
    await sleep(250);
  }
  const expandedDiagnostics = await evalIn(app, `({
    mode: document.querySelector('[data-testid="browser-panel-shell"]')?.getAttribute('data-browser-presentation'),
    groupWidth: document.querySelector('[data-testid="browser-panel-shell"]')?.parentElement?.parentElement?.getBoundingClientRect().width,
    buttonLabel: document.querySelector('[data-testid="side-panel-expand"]')?.getAttribute('aria-label'),
  })`);
  expect(expandedWidth, JSON.stringify(expandedDiagnostics)).toBeGreaterThan(Number(panelWidth) + 150);
  expect(await evalIn(app, `document.querySelector('[data-testid="browser-panel-shell"]')?.getAttribute('data-browser-presentation')`)).toBe("expanded");
  await clickControl("side-panel-expand");
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const mode = await evalIn(app, `document.querySelector('[data-testid="browser-panel-shell"]')?.getAttribute('data-browser-presentation')`);
    if (mode === "docked") break;
    await sleep(250);
  }
  expect(await evalIn(app, `document.querySelector('[data-testid="browser-panel-shell"]')?.getAttribute('data-browser-presentation')`)).toBe("docked");
  evidence.recordAssertionEvidence("Expand and Restore preserve the browser", `The browser grew from ${Math.round(Number(panelWidth))}px to ${Math.round(expandedWidth)}px and returned to docked mode.`, true);

  await clickControl("browser-annotate");
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (await evalIn(app, `Boolean(document.querySelector('[data-testid="browser-annotation-overlay"]'))`)) break;
    await sleep(250);
  }
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const visible = await evalIn(app, `window.__SOFIA_ELECTRON__.browser.getState().then((state) => state.viewVisible)`, { awaitPromise: true });
    if (!visible) break;
    await sleep(250);
  }
  expect(await evalIn(app, `window.__SOFIA_ELECTRON__.browser.getState().then((state) => state.viewVisible)`, { awaitPromise: true })).toBe(false);
  const annotationPoint = await evalIn(app, `(() => {
    const rect = document.querySelector('[data-testid="browser-annotation-overlay"]')?.getBoundingClientRect();
    return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null;
  })()`);
  if (!annotationPoint || typeof annotationPoint !== "object" || !("x" in annotationPoint) || !("y" in annotationPoint)) throw new Error("Annotation surface missing");
  const ax = Number(annotationPoint.x);
  const ay = Number(annotationPoint.y);
  await evalIn(app, `document.querySelector('[data-testid="browser-annotation-overlay"] > div')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: ${ax}, clientY: ${ay} }))`);
  expect(await evalIn(app, `document.querySelector('[data-testid="browser-annotation-overlay"]')?.getAttribute('data-dragging')`)).toBe("true");
  await evalIn(app, `window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, button: 0, clientX: ${ax + 80}, clientY: ${ay + 40} })); window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: ${ax + 80}, clientY: ${ay + 40} }))`);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await evalIn(app, `Boolean(document.querySelector('input[aria-label="Annotation note"]'))`)) break;
    await sleep(250);
  }
  const selectionDiagnostics = await evalIn(app, `(() => {
    return {
      overlay: Boolean(document.querySelector('[data-testid="browser-annotation-overlay"]')),
      controls: document.querySelector('[data-testid="browser-annotation-controls"]')?.textContent,
      hit: document.elementFromPoint(${ax + 40}, ${ay + 20})?.outerHTML.slice(0, 180),
    };
  })()`);
  expect(await evalIn(app, `Boolean(document.querySelector('input[aria-label="Annotation note"]'))`), JSON.stringify(selectionDiagnostics)).toBe(true);
  await evalIn(app, `document.querySelector('input[aria-label="Annotation note"]')?.focus()`);
  await app.client.send("Input.insertText", { text: "Check this selected area" });
  const noteBeforeSave = await evalIn(app, `({ value: document.querySelector('input[aria-label="Annotation note"]')?.value, disabled: document.querySelector('button[aria-label="Add annotation to task"]')?.disabled })`);
  expect(noteBeforeSave).toEqual({ value: "Check this selected area", disabled: false });
  await evalIn(app, `document.querySelector('button[aria-label="Add annotation to task"]')?.click()`);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (!(await evalIn(app, `Boolean(document.querySelector('[data-testid="browser-annotation-overlay"]'))`))) break;
    await sleep(250);
  }
  expect(await evalIn(app, `Boolean(document.querySelector('[data-testid="browser-annotation-overlay"]'))`)).toBe(false);
  expect(await evalIn(app, `Array.from(document.querySelectorAll('[contenteditable="true"]')).some((editor) => editor.textContent?.includes('Check this selected area'))`)).toBe(false);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await evalIn(app, `Array.from(document.querySelectorAll('[contenteditable="true"]')).some((editor) => editor.textContent?.includes('1 annotation'))`)) break;
    await sleep(250);
  }
  const annotationDiagnostics = await evalIn(app, `({
    chips: Array.from(document.querySelectorAll('[data-attachment-id]')).map((chip) => ({ text: chip.textContent, html: chip.outerHTML.slice(0, 300) })),
    editors: Array.from(document.querySelectorAll('[contenteditable="true"]')).map((editor) => editor.textContent?.slice(0, 300)),
  })`);
  expect(await evalIn(app, `Array.from(document.querySelectorAll('[data-attachment-id]')).some((chip) => chip.textContent?.includes('1 annotation'))`), JSON.stringify(annotationDiagnostics)).toBe(true);
  evidence.recordAssertionEvidence("Annotation attaches a selected region", "A live-page snapshot accepted a region and note, then returned to browsing with one compact annotation chip in the composer.", true);
});
