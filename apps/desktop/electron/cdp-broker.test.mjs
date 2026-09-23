import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { WebSocketServer } from "ws";

import { createCdpBroker } from "./cdp-broker.mjs";

function startFakeUpstream() {
  const recorded = { http: [], input: [], evaluate: [], addScript: [] };
  let listenPort = 9001;
  const httpServer = http.createServer((req, res) => {
    recorded.http.push({ method: req.method, url: req.url });
    if (req.url?.startsWith("/json/list")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([
        {
          id: "TARGET-1",
          type: "page",
          url: "https://example.com",
          webSocketDebuggerUrl: `ws://127.0.0.1:${listenPort}/devtools/page/TARGET-1`,
        },
      ]));
      return;
    }
    if (req.url?.startsWith("/json/version")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        webSocketDebuggerUrl: `ws://127.0.0.1:${listenPort}/devtools/browser/BROWSER-1`,
      }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end("{}");
  });

  const wss = new WebSocketServer({ server: httpServer });

  wss.on("connection", (ws) => {
    ws.on("message", (data) => {
      let msg;
      try { msg = JSON.parse(String(data)); } catch { return; }
      const withSession = { ...msg, sessionId: msg.sessionId ?? null };
      if (msg.method === "Input.dispatchMouseEvent") {
        recorded.input.push(withSession);
      } else if (msg.method === "Runtime.evaluate") {
        recorded.evaluate.push(withSession);
        if (String(withSession.params?.expression ?? "").includes("__sofiaAgentCursor.present")) {
          ws.send(JSON.stringify({ id: msg.id, result: { result: { type: "string", value: "640,360" } } }));
          return;
        }
      } else if (msg.method === "Page.addScriptToEvaluateOnNewDocument") {
        recorded.addScript.push(withSession);
      }
      ws.send(JSON.stringify({ id: msg.id, result: {} }));
    });
  });

  return new Promise((resolve) => {
    httpServer.listen(0, "127.0.0.1", () => {
      listenPort = serverPort(httpServer);
      resolve({ httpServer, wss, recorded, port: listenPort });
    });
  });
}

function serverPort(server) {
  const address = server.address();
  if (address && typeof address === "object") return address.port;
  throw new Error("server is not listening");
}

describe("createCdpBroker", () => {
  it("rewrites webSocketDebuggerUrl to the broker in /json/list", async () => {
    const upstream = await startFakeUpstream();
    const broker = await createCdpBroker({
      upstreamBaseUrl: `http://127.0.0.1:${upstream.port}`,
    });
    try {
      const res = await fetch(`${broker.baseUrl}/json/list`);
      const body = await res.json();
      assert.equal(body[0].webSocketDebuggerUrl, `ws://127.0.0.1:${broker.port}/devtools/page/TARGET-1`);
      assert.equal(body[0].id, "TARGET-1");
    } finally {
      await broker.close();
      upstream.wss.close();
      upstream.httpServer.close();
    }
  });

  it("rewrites webSocketDebuggerUrl to the broker in /json/version", async () => {
    const upstream = await startFakeUpstream();
    const broker = await createCdpBroker({
      upstreamBaseUrl: `http://127.0.0.1:${upstream.port}`,
    });
    try {
      const res = await fetch(`${broker.baseUrl}/json/version`);
      const body = await res.json();
      assert.equal(body.webSocketDebuggerUrl, `ws://127.0.0.1:${broker.port}/devtools/browser/BROWSER-1`);
    } finally {
      await broker.close();
      upstream.wss.close();
      upstream.httpServer.close();
    }
  });

  it("injects the cursor script and replays eased hover motion before a click", async () => {
    const upstream = await startFakeUpstream();
    const broker = await createCdpBroker({
      upstreamBaseUrl: `http://127.0.0.1:${upstream.port}`,
      stepMs: 1,
    });
    try {
      const { WebSocket } = await import("ws");
      const ws = new WebSocket(`${broker.baseUrl.replace(/^http/, "ws")}/devtools/page/TARGET-1`);

      const opened = new Promise((resolve, reject) => {
        ws.on("open", resolve);
        ws.on("error", reject);
      });
      await opened;

      const response = new Promise((resolve) => {
        ws.on("message", (data) => resolve(JSON.parse(String(data))));
      });

      ws.send(JSON.stringify({
        id: 1,
        method: "Input.dispatchMouseEvent",
        params: { type: "mousePressed", x: 300, y: 200, button: "left", buttons: 1, clickCount: 1 },
      }));

      const res = await response;
      assert.equal(res.id, 1);

      const inputEvents = upstream.recorded.input;
      const pressEvents = inputEvents.filter((p) => p.params?.type === "mousePressed");
      const moveEvents = inputEvents.filter((p) => p.params?.type === "mouseMoved");

      assert.equal(pressEvents.length, 1);
      assert.deepEqual({ x: pressEvents[0].params.x, y: pressEvents[0].params.y }, { x: 300, y: 200 });
      assert.ok(moveEvents.length >= 4, `expected eased motion, got ${moveEvents.length} moves`);
      assert.equal(moveEvents[moveEvents.length - 1].params.x, 300);
      assert.equal(moveEvents[moveEvents.length - 1].params.y, 200);

      const injected = upstream.recorded.addScript.length + upstream.recorded.evaluate.length;
      assert.ok(injected >= 2, "cursor script should be injected via addScript + evaluate");
      const cursorMoves = upstream.recorded.evaluate.filter((p) =>
        p.params?.expression?.includes("__sofiaAgentCursor"),
      );
      assert.ok(cursorMoves.length > 0, "ghost cursor should be moved via Runtime.evaluate");
    } finally {
      await broker.close();
      upstream.wss.close();
      upstream.httpServer.close();
    }
  });

  it("passes non-Input commands through untouched", async () => {
    const upstream = await startFakeUpstream();
    const broker = await createCdpBroker({
      upstreamBaseUrl: `http://127.0.0.1:${upstream.port}`,
    });
    try {
      const { WebSocket } = await import("ws");
      const ws = new WebSocket(`${broker.baseUrl.replace(/^http/, "ws")}/devtools/page/TARGET-1`);
      await new Promise((resolve, reject) => {
        ws.on("open", resolve);
        ws.on("error", reject);
      });

      const response = new Promise((resolve) => {
        ws.on("message", (data) => resolve(JSON.parse(String(data))));
      });

      ws.send(JSON.stringify({
        id: 42,
        method: "Page.navigate",
        params: { url: "https://example.com/next" },
      }));

      const res = await response;
      assert.equal(res.id, 42);
      assert.deepEqual(res.result, {});
    } finally {
      await broker.close();
      upstream.wss.close();
      upstream.httpServer.close();
    }
  });

  it("animates a mouseMoved jump so the cursor arrives on the button before the press", async () => {
    const upstream = await startFakeUpstream();
    const broker = await createCdpBroker({
      upstreamBaseUrl: `http://127.0.0.1:${upstream.port}`,
      stepMs: 1,
    });
    try {
      const { WebSocket } = await import("ws");
      const ws = new WebSocket(`${broker.baseUrl.replace(/^http/, "ws")}/devtools/page/TARGET-1`);
      await new Promise((resolve, reject) => {
        ws.on("open", resolve);
        ws.on("error", reject);
      });

      const responses = [];
      ws.on("message", (data) => {
        responses.push(JSON.parse(String(data)));
      });

      // Puppeteer click pattern: a big mouseMoved jump, then the press.
      ws.send(JSON.stringify({
        id: 50,
        method: "Input.dispatchMouseEvent",
        params: { type: "mouseMoved", x: 400, y: 300, button: "none", buttons: 0 },
      }));
      ws.send(JSON.stringify({
        id: 51,
        method: "Input.dispatchMouseEvent",
        params: { type: "mousePressed", x: 400, y: 300, button: "left", buttons: 1, clickCount: 1 },
      }));

      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        if (responses.some((r) => r.id === 50) && responses.some((r) => r.id === 51)) break;
        await new Promise((r) => setTimeout(r, 20));
      }

      const moveEvents = upstream.recorded.input.filter((p) => p.params?.type === "mouseMoved");
      assert.ok(moveEvents.length >= 4, `expected eased motion on the jump, got ${moveEvents.length} moves`);
      // The final eased step lands exactly on the button before the press.
      const finalMove = moveEvents[moveEvents.length - 1];
      assert.equal(finalMove.params.x, 400);
      assert.equal(finalMove.params.y, 300);

      const cursorMoves = upstream.recorded.evaluate.filter((p) =>
        p.params?.expression?.includes("__sofiaAgentCursor.moveTo"),
      );
      assert.ok(cursorMoves.length >= 1, "ghost cursor should move to the button");
      const lastCursorMove = cursorMoves[cursorMoves.length - 1];
      assert.match(lastCursorMove.params.expression, /moveTo\(400,300\)/);
    } finally {
      await broker.close();
      upstream.wss.close();
      upstream.httpServer.close();
    }
  });

  it("replays eased hover motion for browser-level sessions via sessionId", async () => {
    const upstream = await startFakeUpstream();
    const broker = await createCdpBroker({
      upstreamBaseUrl: `http://127.0.0.1:${upstream.port}`,
      stepMs: 1,
    });
    try {
      const { WebSocket } = await import("ws");
      const ws = new WebSocket(`${broker.baseUrl.replace(/^http/, "ws")}/devtools/browser/BROWSER-1`);
      await new Promise((resolve, reject) => {
        ws.on("open", resolve);
        ws.on("error", reject);
      });

      const response = new Promise((resolve) => {
        ws.on("message", (data) => resolve(JSON.parse(String(data))));
      });

      ws.send(JSON.stringify({
        id: 7,
        sessionId: "PAGE-SESSION-1",
        method: "Input.dispatchMouseEvent",
        params: { type: "mousePressed", x: 200, y: 150, button: "left", buttons: 1, clickCount: 1 },
      }));

      const res = await response;
      assert.equal(res.id, 7);

      const syntheticInputs = upstream.recorded.input.filter((p) => p.params?.type === "mouseMoved");
      assert.ok(syntheticInputs.length >= 4, `expected eased motion, got ${syntheticInputs.length} moves`);

      const syntheticSessions = upstream.recorded.evaluate
        .filter((p) => p.params?.expression?.includes("__sofiaAgentCursor"));
      assert.ok(syntheticSessions.length > 0, "cursor moves should be emitted for the page session");
      assert.ok(
        syntheticSessions.every((p) => p.sessionId === "PAGE-SESSION-1"),
        "synthetic cursor commands must propagate the page sessionId",
      );
    } finally {
      await broker.close();
      upstream.wss.close();
      upstream.httpServer.close();
    }
  });

  it("shows the ghost cursor on non-Input page activity (navigate/evaluate)", async () => {
    const upstream = await startFakeUpstream();
    const broker = await createCdpBroker({
      upstreamBaseUrl: `http://127.0.0.1:${upstream.port}`,
      stepMs: 1,
    });
    try {
      const { WebSocket } = await import("ws");
      const ws = new WebSocket(`${broker.baseUrl.replace(/^http/, "ws")}/devtools/browser/BROWSER-1`);
      await new Promise((resolve, reject) => {
        ws.on("open", resolve);
        ws.on("error", reject);
      });

      const response = new Promise((resolve) => {
        ws.on("message", (data) => resolve(JSON.parse(String(data))));
      });

      ws.send(JSON.stringify({
        id: 9,
        sessionId: "PAGE-SESSION-1",
        method: "Page.navigate",
        params: { url: "https://example.com/next" },
      }));

      const res = await response;
      assert.equal(res.id, 9);

      const presents = upstream.recorded.evaluate.filter((p) =>
        p.params?.expression?.includes("__sofiaAgentCursor.present"),
      );
      assert.ok(presents.length >= 1, "cursor should present on page activity");
      assert.equal(presents[0].sessionId, "PAGE-SESSION-1");
    } finally {
      await broker.close();
      upstream.wss.close();
      upstream.httpServer.close();
    }
  });

  it("routes Target.createTarget to a real tab when a createTarget handler is provided", async () => {
    const upstream = await startFakeUpstream();
    let createdTab = null;
    const broker = await createCdpBroker({
      upstreamBaseUrl: `http://127.0.0.1:${upstream.port}`,
      createTarget: async (params) => {
        createdTab = params;
        return { targetId: "NEW-TAB-1", tabId: "tab_new_1", url: params.url ?? "about:blank" };
      },
    });
    try {
      const { WebSocket } = await import("ws");
      const ws = new WebSocket(`${broker.baseUrl.replace(/^http/, "ws")}/devtools/browser/BROWSER-1`);
      await new Promise((resolve, reject) => {
        ws.on("open", resolve);
        ws.on("error", reject);
      });

      const response = new Promise((resolve) => {
        ws.on("message", (data) => resolve(JSON.parse(String(data))));
      });

      ws.send(JSON.stringify({
        id: 33,
        method: "Target.createTarget",
        params: { url: "https://example.com/new", background: false },
      }));

      const res = await response;
      assert.equal(res.id, 33);
      assert.deepEqual(res.result, { targetId: "NEW-TAB-1" });
      assert.deepEqual(createdTab, { url: "https://example.com/new", background: false });
      // The command must NOT be forwarded upstream.
      assert.equal(upstream.recorded.http.length, 0);
    } finally {
      await broker.close();
      upstream.wss.close();
      upstream.httpServer.close();
    }
  });
});
