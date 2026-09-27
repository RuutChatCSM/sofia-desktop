import { describe, expect, test } from "bun:test";

import { BROWSER_CURSOR_SCRIPT, createBrowserCursor } from "./browser-cursor.mjs";

/** A page that records what the controller asked it to do. */
function fakePage() {
  const calls: { method: string; expression: string }[] = [];
  const send = async (method: string, params: Record<string, unknown> = {}) => {
    calls.push({ method, expression: String(params.expression ?? params.source ?? "") });
    return {};
  };
  // The overlay script itself mentions moveTo/flash/fade, so only count the
  // calls the controller makes *after* installing it.
  const evaluates = () =>
    calls
      .filter((c) => c.method === "Runtime.evaluate" && c.expression !== BROWSER_CURSOR_SCRIPT)
      .map((c) => c.expression);
  const moves = () => evaluates().filter((e) => e.includes("moveTo("));
  return { send, calls, evaluates, moves };
}

describe("agent cursor presentation", () => {
  test("installs the overlay once, for this document and every later one", async () => {
    const page = fakePage();
    const cursor = createBrowserCursor({ send: page.send });

    await cursor.move(100, 100);
    await cursor.move(200, 200);

    const installs = page.calls.filter((c) => c.method === "Page.addScriptToEvaluateOnNewDocument");
    expect(installs.length).toBe(1);
    expect(installs[0].expression).toBe(BROWSER_CURSOR_SCRIPT);
    // …and it is applied to the document that is already open.
    expect(page.calls.some((c) => c.expression === BROWSER_CURSOR_SCRIPT)).toBe(true);
  });

  test("a cursor that is not on screen arrives from nearby, then glides", async () => {
    const page = fakePage();
    const cursor = createBrowserCursor({ send: page.send });
    expect(cursor.isShown()).toBe(false);

    await cursor.move(300, 200);

    expect(cursor.isShown()).toBe(true);
    // Two moves: the arrival approach, then the target itself.
    expect(page.moves().length).toBe(2);
    expect(page.moves()[0]).toContain("moveTo(274, 180)");
    expect(page.moves()[1]).toContain("moveTo(300, 200)");
  });

  test("a cursor already on screen only glides", async () => {
    const page = fakePage();
    const cursor = createBrowserCursor({ send: page.send });
    await cursor.move(300, 200);

    await cursor.move(120, 80);

    expect(page.moves().length).toBe(3);
    expect(page.moves()[2]).toContain("moveTo(120, 80)");
  });

  test("click glides and bursts; a double click bursts twice", async () => {
    const page = fakePage();
    const cursor = createBrowserCursor({ send: page.send });

    await cursor.click(50, 60);
    expect(page.moves().at(-1)).toContain("moveTo(50, 60)");
    expect(page.evaluates().filter((e) => e.includes("flash(50, 60)")).length).toBe(1);

    await cursor.doubleClick(70, 80);
    expect(page.evaluates().filter((e) => e.includes("flash(70, 80)")).length).toBe(2);
  });

  test("fade stops claiming a position, and the next move arrives again", async () => {
    const page = fakePage();
    const cursor = createBrowserCursor({ send: page.send });
    await cursor.move(300, 200);

    await cursor.fade();
    expect(cursor.isShown()).toBe(false);
    expect(page.evaluates().at(-1)).toContain("fade");

    await cursor.move(90, 90);
    expect(cursor.isShown()).toBe(true);
    // It arrives from nearby rather than gliding from where it used to be.
    expect(page.moves().at(-1)).toContain("moveTo(90, 90)");
    expect(page.moves().at(-2)).toContain("moveTo(64, 70)");
  });

  test("fading a cursor that was never shown asks the page for nothing", async () => {
    const page = fakePage();
    const cursor = createBrowserCursor({ send: page.send });

    await cursor.fade();
    await cursor.ready();

    expect(page.evaluates().filter((e) => e.includes("fade"))).toEqual([]);
    expect(page.evaluates().filter((e) => e.includes("moveTo("))).toEqual([]);
  });

  test("a page that refuses the overlay never fails the action that asked", async () => {
    const failures = { count: 0 };
    const cursor = createBrowserCursor({
      send: async () => {
        failures.count += 1;
        throw new Error("target closed while handling command");
      },
    });

    await cursor.move(10, 10);
    await cursor.click(10, 10);
    await cursor.fade();

    expect(failures.count).toBeGreaterThan(0);
  });
});
