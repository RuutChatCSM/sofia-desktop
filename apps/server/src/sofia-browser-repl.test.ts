import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { createInterface } from "node:readline";

import { afterEach, describe, expect, test } from "bun:test";

const children: ChildProcessWithoutNullStreams[] = [];
const homes: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) child.kill("SIGTERM");
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** A Sofia engine home whose host is never reachable, so tests exercise the
 * stale-registration paths instead of a developer's live bridge. */
async function isolatedHome(discovery?: { url: string }) {
  const home = await mkdtemp(join(tmpdir(), "sofia-repl-home-"));
  homes.push(home);
  if (discovery) {
    await writeFile(
      join(home, "sofia-cdp-broker.json"),
      `${JSON.stringify({ schemaVersion: 1, url: discovery.url, appIdentifier: "test", pid: 1 })}\n`,
    );
  }
  return home;
}

/** Stand-in for the desktop CDP broker. Only the HTTP surface the harness
 * probes, so a test can prove which endpoint it selected. */
async function startStubBridge() {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url ?? "");
    res.setHeader("content-type", "application/json");
    res.end(req.url?.startsWith("/json/version")
      ? JSON.stringify({ webSocketDebuggerUrl: "ws://127.0.0.1:1/devtools/browser/stub" })
      : "[]");
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("stub bridge did not bind a port");
  return { url: `http://127.0.0.1:${address.port}`, requests };
}

/**
 * Stand-in for the desktop broker *and* one of its pages, so a test can see the
 * exact CDP traffic a semantic browser action produces. HTTP answers the two
 * discovery endpoints; the websocket answers CDP and records what it was asked.
 */
async function startFakeBridgeWithPage() {
  const expressions: string[] = [];
  const methods: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/json/version") {
        return Response.json({ webSocketDebuggerUrl: `ws://127.0.0.1:${srv.port}/devtools/browser/BROWSER-1` });
      }
      if (url.pathname === "/json/list") {
        return Response.json([
          {
            id: "PAGE-1",
            type: "page",
            title: "Fake page",
            url: `data:text/html,${encodeURIComponent("sofia-browser-tab:tab_test_1")}`,
            webSocketDebuggerUrl: `ws://127.0.0.1:${srv.port}/devtools/page/PAGE-1`,
          },
        ]);
      }
      return Response.json([]);
    },
    websocket: {
      open() {},
      message(ws, raw) {
        let msg: any;
        try { msg = JSON.parse(String(raw)); } catch { return; }
        methods.push(String(msg.method ?? ""));
        if (msg.method === "Runtime.evaluate") expressions.push(String(msg.params?.expression ?? ""));
        // `runAct`/`snapshot` read `.result.value`; a centre is all this page has.
        ws.send(JSON.stringify({ id: msg.id, result: { result: { type: "object", value: { ok: true, x: 40, y: 60 }, description: "Object" } } }));
      },
    },
  });
  servers.push({ close: (cb: () => void) => { void server.stop(true); cb?.(); } } as unknown as Server);
  return {
    url: `http://127.0.0.1:${server.port}`,
    expressions,
    methods,
    moves: () => expressions.filter((e) => e.includes("__sofiaAgentCursor.moveTo(")),
    fades: () => expressions.filter((e) => e.includes("fade")),
    cursorExpressions: () => expressions.filter((e) => e.includes("__sofiaAgentCursor")),
  };
}

function startRepl(options: { brokerUrl?: string; sofiaHome: string } ) {
  const child = spawn("node", [join(import.meta.dir, "sofia-browser-repl.mjs")], {
    env: {
      ...process.env,
      SOFIA_BROWSER_CDP_URL: options.brokerUrl ?? "http://127.0.0.1:1",
      SOFIA_HOME: options.sofiaHome,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(child);
  const lines = createInterface({ input: child.stdout });
  const replies = new Map<number, (value: any) => void>();
  lines.on("line", (line) => {
    const message = JSON.parse(line) as { id?: number };
    if (message.id != null) replies.get(message.id)?.(message);
  });
  const request = (id: number, method: string, params?: unknown) =>
    new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${method}`)), 2_000);
      replies.set(id, (value) => {
        clearTimeout(timer);
        replies.delete(id);
        resolve(value);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  return { request };
}

describe("sofia browser Node REPL", () => {
  test("keeps global bindings across tool calls", async () => {
    const repl = startRepl({ sofiaHome: await isolatedHome() });
    await repl.request(1, "initialize");
    await repl.request(2, "tools/call", {
      name: "js",
      arguments: { code: "globalThis.counter = 41; return counter" },
    });
    const response = await repl.request(3, "tools/call", {
      name: "js",
      arguments: { code: "globalThis.counter += 1; return counter" },
    });
    expect(response.result.content).toEqual([{ type: "text", text: "42" }]);
  });

  test("returns screenshot-like values as MCP image content", async () => {
    const repl = startRepl({ sofiaHome: await isolatedHome() });
    const response = await repl.request(1, "tools/call", {
      name: "js",
      arguments: { code: 'return { data: "YWJj", mimeType: "image/png" }' },
    });
    expect(response.result.content).toEqual([
      { type: "image", data: "YWJj", mimeType: "image/png" },
    ]);
  });

  test("reports a stale bridge instead of hanging or returning an empty tab list", async () => {
    // The engine records an ephemeral broker port in config.toml, so a stale
    // entry outlives the app that wrote it. The tool must say so, not hang.
    const repl = startRepl({ brokerUrl: "http://127.0.0.1:59558", sofiaHome: await isolatedHome() });
    const response = await repl.request(1, "tools/call", {
      name: "js",
      arguments: {
        code: "const browser = await setupBrowserRuntime(); return await browser.browsers.get('iab').tabs.list();",
      },
    });
    expect(response.error.message).toContain("in-app browser bridge is not answering");
    expect(response.error.message).toContain("http://127.0.0.1:59558");
  });

  test("falls back to the published bridge when the recorded URL is stale", async () => {
    // A sibling build rewrites the shared config.toml with its own dead port.
    // The discovery file the live app publishes must still take over.
    const bridge = await startStubBridge();
    const repl = startRepl({ brokerUrl: "http://127.0.0.1:2", sofiaHome: await isolatedHome({ url: bridge.url }) });
    const response = await repl.request(1, "tools/call", {
      name: "js",
      arguments: { code: "const b = await setupBrowserRuntime(); return await b.browsers.get('iab').tabs.list();" },
    });
    expect(response.result.content).toEqual([{ type: "text", text: "[]" }]);
    expect(bridge.requests).toContain("/json/list");
  });

  test("semantic browser actions drive the virtual cursor", async () => {
    // The cursor is presentation state: a hover moves it, a read does not, and a
    // navigation fades it. None of this may depend on which transport performed
    // the page interaction.
    const page = await startFakeBridgeWithPage();
    const repl = startRepl({ brokerUrl: "http://127.0.0.1:2", sofiaHome: await isolatedHome({ url: page.url }) });
    await repl.request(1, "initialize");

    const read = await repl.request(2, "tools/call", {
      name: "js",
      arguments: { code: "const b = await setupBrowserRuntime(); const t = (await b.browsers.get('iab').tabs.list())[0]; await t.see(); return 'read'", },
    });
    expect(read.error).toBeUndefined();
    expect(page.cursorExpressions()).toEqual([]);

    const hover = await repl.request(3, "tools/call", {
      name: "js",
      arguments: { code: "const b = await setupBrowserRuntime(); const t = (await b.browsers.get('iab').tabs.list())[0]; await t.hover({ role: 'button' }); return 'hover'", },
    });
    expect(hover.error).toBeUndefined();
    expect(page.moves().length).toBeGreaterThanOrEqual(2);
    // A cursor that was not on screen arrives from nearby, then lands on target.
    expect(page.moves()[0]).toContain("moveTo(14, 40)");
    expect(page.moves()[1]).toContain("moveTo(40, 60)");

    const before = page.moves().length;
    const nav = await repl.request(4, "tools/call", {
      name: "js",
      arguments: { code: "const b = await setupBrowserRuntime(); const t = (await b.browsers.get('iab').tabs.list())[0]; await t.goto('https://example.com/next'); return 'nav'", },
    });
    expect(nav.error).toBeUndefined();
    expect(page.fades().length).toBeGreaterThanOrEqual(1);
    expect(page.moves().length).toBe(before);
  });
});
