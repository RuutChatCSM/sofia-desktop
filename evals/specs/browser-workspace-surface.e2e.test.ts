import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";

import { control, createAndSelectWorkspace, evalIn } from "@sofia/behaviors";
import { connect, debuggerUrlFor, evaluate, listTargets } from "@sofia/cdp";
import { desktop } from "@sofia/hosts";
import { needs, test } from "@sofia/testkit";
import { expect, onTestFinished } from "vitest";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("browser icon opens split and Expand uses a flat workspace surface", { timeout: 5 * 60_000 }, async ({ evidence, skip }) => {
  needs({ optIn: ["SOFIA_EVAL_E2E_TESTS"] });
  await using app = await desktop({ name: "browser-workspace-surface" });
  if (app.handle.hostKind !== "local") skip("the fixture runs on the local driver host");

  const fixture = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>Browser controls</title><body style='margin:0;background:#ff00ff'><p>Distinctive browser search phrase</p></body>");
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
    if (await evalIn(app, `Boolean(document.querySelector('button[aria-label="Browser"]:not(:disabled)'))`)) break;
    await sleep(250);
  }
  await evalIn(app, `document.querySelector('button[aria-label="Browser"]')?.click()`);
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await evalIn(app, `Boolean(document.querySelector('[data-testid="browser-menu-trigger"]'))`)) break;
    await sleep(250);
  }
  expect(await evalIn(app, `document.querySelector('[data-testid="browser-panel-shell"]')?.getAttribute('data-browser-presentation')`)).toBe("docked");
  expect(await evalIn(app, `(() => {
    const toolbar = document.querySelector('[data-testid="browser-toolbar"]');
    const nav = toolbar.querySelector('[data-testid="browser-navigation"]');
    const annotate = toolbar.querySelector('[data-testid="browser-annotate"]');
    const address = toolbar.querySelector('[aria-label="Address"]');
    return {
      navigation: Array.from(nav.querySelectorAll('button')).map(button => button.getAttribute('aria-label')),
      order: Boolean(nav.compareDocumentPosition(annotate) & Node.DOCUMENT_POSITION_FOLLOWING) && Boolean(annotate.compareDocumentPosition(address) & Node.DOCUMENT_POSITION_FOLLOWING),
      close: Boolean(toolbar.querySelector('[aria-label="Close panel"]')),
    };
  })()`)).toEqual({ navigation: ["Go back", "Go forward", "Reload page"], order: true, close: false });
  await evalIn(app, `document.querySelector('[data-testid="browser-menu-trigger"]').click()`);
  let overlayTarget;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    overlayTarget = (await listTargets(app.handle.cdpUrl)).find(target => target.url.endsWith('/overlay.html') && target.webSocketDebuggerUrl);
    if (overlayTarget) break;
    await sleep(100);
  }
  if (!overlayTarget) throw new Error("Native browser menu did not open");
  const overlay = await connect(debuggerUrlFor(app.handle.cdpUrl, overlayTarget));
  onTestFinished(() => overlay.close());
  for (const label of ["Device toolbar", "Phone · 390 × 844"]) {
    let clicked = false;
    for (let attempt = 0; attempt < 60 && !clicked; attempt += 1) {
      clicked = Boolean(await evaluate(overlay, `(() => {
        const button = Array.from(document.querySelectorAll('button')).find(button => button.textContent.includes(${JSON.stringify(label)}));
        if (!button) return false;
        button.click(); return true;
      })()`));
      if (!clicked) await sleep(100);
    }
    expect(clicked).toBe(true);
  }
  await sleep(500);
  expect(await evalIn(app, `Boolean(document.querySelector('[data-testid="browser-viewport-trigger"]'))`)).toBe(true);
  const flatSurface = () => evalIn(app, `(() => {
    const shell = document.querySelector('[data-testid="browser-panel-shell"]');
    const style = getComputedStyle(shell);
    return { shadow: style.boxShadow, radius: style.borderTopLeftRadius, backdrop: style.backdropFilter };
  })()`);
  expect(await flatSurface()).toEqual({ shadow: "none", radius: "0px", backdrop: "none" });
  await evalIn(app, `document.querySelector('[data-testid="side-panel-expand"]')?.click()`);
  await sleep(250);
  expect(await evalIn(app, `document.querySelector('[data-testid="browser-panel-shell"]')?.getAttribute('data-browser-presentation')`)).toBe("expanded");
  expect(await flatSurface()).toEqual({ shadow: "none", radius: "0px", backdrop: "none" });
  expect(await evalIn(app, `Boolean(document.querySelector('[data-testid="browser-responsive-controls"]'))`)).toBe(false);
  await evalIn(app, `document.querySelector('[data-testid="browser-viewport-trigger"]').click()`);
  await sleep(150);
  expect(await evalIn(app, `Boolean(document.querySelector('[data-testid="browser-responsive-controls"]'))`)).toBe(true);
  expect(await evalIn(app, `document.querySelector('[aria-label="Viewport device"]').tagName`)).toBe("SELECT");
  expect(await evalIn(app, `Boolean(document.querySelector('[data-testid="browser-viewport-palette"]'))`)).toBe(false);
  await evalIn(app, `(() => { const select = document.querySelector('[aria-label="Viewport device"]'); select.value = 'iphone-15-pro'; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await sleep(150);
  expect(await evalIn(app, `document.querySelector('[aria-label="Viewport width"]').value`)).toBe("393");
  expect(await evalIn(app, `document.querySelector('[aria-label="Viewport height"]').value`)).toBe("852");
  await evalIn(app, `document.querySelector('[aria-label="Rotate viewport"]').click()`);
  await sleep(150);
  expect(await evalIn(app, `document.querySelector('[aria-label="Viewport width"]').value`)).toBe("852");
  expect(await evalIn(app, `document.querySelector('[aria-label="Viewport height"]').value`)).toBe("393");
  await evalIn(app, `(() => { const select = document.querySelector('[aria-label="Viewport device"]'); select.value = 'phone'; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await sleep(150);
  await evalIn(app, `document.querySelector('[aria-label="Close responsive controls"]').click()`);
  await sleep(500);
  const centered = await evalIn(app, `(async () => {
    const rect = document.querySelector('[data-testid="browser-canvas"]').getBoundingClientRect();
    const tab = (await window.__SOFIA_ELECTRON__.browser.listTabs())[0];
    return Boolean(tab.appliedBounds) && Math.abs(tab.appliedBounds.x + tab.appliedBounds.width / 2 - rect.left - rect.width / 2) < 2 && tab.appliedBounds.width < rect.width - 100 && tab.viewport.width === 390;
  })()`, { awaitPromise: true });
  expect(centered, "Phone frame must be narrow, centered, and remain active after closing responsive controls").toBe(true);
  const railPoint = await evalIn(app, `(() => {
    const canvas = document.querySelector('[data-testid="browser-canvas"]').getBoundingClientRect();
    const marker = document.createElement('div');
    marker.style.cssText = 'position:fixed;z-index:9999;background:#00ff00;width:20px;height:20px;pointer-events:none';
    marker.style.left = (canvas.right + 8) + 'px';
    marker.style.top = (canvas.top + 100) + 'px';
    document.body.append(marker);
    return { x: canvas.right + 18, y: canvas.top + 110 };
  })()`);
  if (!railPoint || typeof railPoint !== "object" || !("x" in railPoint) || !("y" in railPoint) || typeof railPoint.x !== "number" || typeof railPoint.y !== "number") throw new Error("No rail sample point");
  await sleep(300);
  if (process.platform === "darwin") {
    const color = execFileSync("swift", [fileURLToPath(new URL("../fixtures/native/browser-edge.swift", import.meta.url)), String(railPoint.x), String(railPoint.y), "/tmp/sofia-browser-native-edge.png"], { encoding: "utf8" }).trim();
    const [red, green, blue] = color.split(',').map(Number);
    expect(green, `Native rail marker must remain green; captured ${color}`).toBeGreaterThan(red + 50);
    expect(green).toBeGreaterThan(blue + 50);
    evidence.recordAssertionEvidence("Native responsive content stays inside the expanded canvas", "A macOS window capture shows the green rail marker untouched beside a centered magenta 390×844 phone page.", true);
  }
  await evalIn(app, `document.querySelector('[data-testid="side-panel-expand"]')?.click()`);
  await sleep(250);
  evidence.recordAssertionEvidence("Direct browser open uses a flat split pane and Expand keeps a flat workspace surface", "A single browser rail click opens docked mode. Split and expanded surfaces have no shadow, corner radius, or backdrop filter.", true);

  await control(app, "eval.markdown_primitive.seed_artifact");
  await sleep(500);
  expect(await evalIn(app, `Boolean(document.querySelector('[aria-label="Expand panel"]'))`)).toBe(true);
  const splitWidth = await evalIn(app, `document.querySelector('[data-testid="browser-panel-shell"]').getBoundingClientRect().width`);
  await evalIn(app, `document.querySelector('[aria-label="Expand panel"]').click()`);
  await sleep(250);
  const expandedWidth = await evalIn(app, `document.querySelector('[data-testid="browser-panel-shell"]').getBoundingClientRect().width`);
  expect(Number(expandedWidth)).toBeGreaterThan(Number(splitWidth) + 100);
  expect(await evalIn(app, `document.querySelector('[data-testid="browser-panel-shell"]').getAttribute('data-panel-presentation')`)).toBe("expanded");
  expect(await evalIn(app, `Boolean(document.querySelector('[data-testid="browser-show-peek"]'))`)).toBe(false);
  await evalIn(app, `document.querySelector('[aria-label="Restore panel"]').click()`);
  await sleep(250);
  const restoredWidth = await evalIn(app, `document.querySelector('[data-testid="browser-panel-shell"]').getBoundingClientRect().width`);
  expect(Math.abs(Number(restoredWidth) - Number(splitWidth))).toBeLessThan(2);
  evidence.recordAssertionEvidence("Files share panel expansion", "A markdown file expands across the workspace and restores the same split width; browser Peek controls are absent.", true);

});
