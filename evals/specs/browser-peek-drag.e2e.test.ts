import { createServer } from "node:http";

import { createAndSelectWorkspace, evalIn } from "@sofia/behaviors";
import { connect, debuggerUrlFor, evaluate, listTargets } from "@sofia/cdp";
import { desktop } from "@sofia/hosts";
import { needs, test } from "@sofia/testkit";
import { expect, onTestFinished } from "vitest";

type Rect = { left: number; top: number; width: number; height: number };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("Peek follows one continuous drag and stays put on release", { timeout: 5 * 60_000 }, async ({ evidence, skip }) => {
  needs({ optIn: ["SOFIA_EVAL_E2E_TESTS"] });
  await using app = await desktop({ name: "browser-peek-drag" });
  if (app.handle.hostKind !== "local") skip("the fixture is served on the local driver host");

  const fixture = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>Peek drag fixture</title><body>Peek drag fixture</body>");
  });
  await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  onTestFinished(() => fixture.close());
  const address = fixture.address();
  if (!address || typeof address === "string") throw new Error("Fixture did not bind");

  await createAndSelectWorkspace(app, { path: `/tmp/sofia-peek-drag-${Date.now()}` });
  const pickerOpen = await evalIn(app, `Boolean(Array.from(document.querySelectorAll('[role="dialog"]')).find((dialog) => dialog.textContent?.includes('Select a model for this session.')))`);
  if (pickerOpen) {
    await app.client.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await app.client.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  }
  await evalIn(app, `window.__SOFIA_ELECTRON__.browser.openUrl("http://127.0.0.1:${address.port}/", "builtin")`, { awaitPromise: true });

  async function peekRect(): Promise<Rect> {
    const rect = await evalIn(app, `(() => {
      const peek = document.querySelector('[data-testid="browser-peek"]');
      if (!peek) return null;
      const rect = peek.getBoundingClientRect();
      return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    })()`);
    if (!rect || typeof rect !== "object" ||
        !("left" in rect) || typeof rect.left !== "number" ||
        !("top" in rect) || typeof rect.top !== "number" ||
        !("width" in rect) || typeof rect.width !== "number" ||
        !("height" in rect) || typeof rect.height !== "number") {
      throw new Error("Peek is not mounted");
    }
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  }

  let initial: Rect | null = null;
  let shieldTarget = null;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    initial = await peekRect().catch(() => null);
    shieldTarget = (await listTargets(app.handle.cdpUrl)).find((target) => target.url.startsWith("data:text/html") && target.url.includes("SOFIA_PEEK_SHIELD"));
    if (initial && shieldTarget?.webSocketDebuggerUrl) break;
    await sleep(250);
  }
  if (!initial || !shieldTarget?.webSocketDebuggerUrl) throw new Error("Peek shield did not appear");
  const shield = await connect(debuggerUrlFor(app.handle.cdpUrl, shieldTarget));
  onTestFinished(() => shield.close());

  const start = { x: initial.width / 2, y: initial.height / 2 };
  await shield.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: start.x, y: start.y, button: "none", buttons: 0 });
  await shield.send("Input.dispatchMouseEvent", { type: "mousePressed", x: start.x, y: start.y, button: "left", buttons: 1, clickCount: 1 });

  for (let step = 1; step <= 6; step += 1) {
    const current = await peekRect();
    const pointerScreenX = initial.left + start.x - step * 20;
    const pointerScreenY = initial.top + start.y + step * 10;
    await shield.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: pointerScreenX - current.left,
      y: pointerScreenY - current.top,
      button: "left",
      buttons: 1,
    });
    await sleep(40);
    expect(await evaluate(shield, `document.body.hasAttribute("data-pressing")`)).toBe(true);
  }

  const moved = await peekRect();
  expect(moved.left).toBeLessThan(initial.left - 70);
  expect(moved.top).toBeGreaterThan(initial.top + 30);
  await shield.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: initial.left + start.x - 120 - moved.left,
    y: initial.top + start.y + 60 - moved.top,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
  await sleep(300);
  const settled = await peekRect();
  expect(settled.left).toBeLessThan(initial.left - 70);
  expect(settled.top).toBeGreaterThan(initial.top + 30);
  expect(await evalIn(app, `Boolean(document.querySelector('[data-testid="browser-peek"]'))`)).toBe(true);
  evidence.recordAssertionEvidence(
    "Peek remains attached through a real pointer drag and keeps its position",
    `The card moved from (${Math.round(initial.left)}, ${Math.round(initial.top)}) to (${Math.round(settled.left)}, ${Math.round(settled.top)}) while the native shield kept its pressed state through six moves; releasing did not open or reset it.`,
    true,
  );
});
