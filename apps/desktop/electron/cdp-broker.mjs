// CDP broker: an engine-agnostic proxy that sits between an agent (Sofia engine,
// Codex, or any CDP client) and the built-in browser panel's Chromium. It
// makes agent-driven browsing feel human by:
//
//   1. Injecting a visible "ghost" cursor into the driven page and moving it
//      with easing before a click lands.
//   2. Replaying real `Input.dispatchMouseEvent` `mouseMoved` steps along that
//      path so hover styles, tooltips, and scroll-into-view actually fire.
//   3. Rewriting `webSocketDebuggerUrl` in `/json/*` so the agent is forced to
//      connect through this proxy instead of straight to Chromium.
//
// The agent's tool surface is unchanged: it still receives `browser_url` +
// `target_id` and calls the same browser_* tools. Every connection and command
// passes through here untouched except the Input domain, so this is fully
// backward compatible for Sofia engine and equally reusable for a future Codex
// runtime.
import http from "node:http";
import { WebSocket, WebSocketServer } from "ws";

const PROXY_PATH_RE = /^\/devtools\/(page|browser)\/([^/?]+)(?:\?.*)?$/;
const SYNTHETIC_ID_BASE = 1_000_000_000;

import { BROWSER_CURSOR_SCRIPT } from './browser-cursor-runtime.mjs';
const CURSOR_SCRIPT = BROWSER_CURSOR_SCRIPT + ';window.__sofiaAgentCursor?.present();';

function easeInOutQuad(t) {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// Human-like path from `from` to `to`: ease-in/out with a small perpendicular
// wobble that decays toward the target so the final position is exact.
function humanPath(from, to) {
  const distance = dist(from, to);
  const steps = Math.min(10, Math.max(4, Math.round(distance / 42)));
  const points = [];
  for (let i = 1; i <= steps; i += 1) {
    const t = easeInOutQuad(i / steps);
    const wobble = Math.sin(i * 1.7) * 3 * Math.sin((Math.PI * i) / steps);
    points.push({
      x: Math.round(from.x + (to.x - from.x) * t + wobble),
      y: Math.round(from.y + (to.y - from.y) * t),
    });
  }
  return points;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function serverPort(server) {
  const address = server.address();
  if (address && typeof address === "object") return address.port;
  throw new Error("server is not listening");
}

/**
 * @param {object} options
 * @param {string} options.upstreamBaseUrl - real CDP base, e.g. http://127.0.0.1:9223
 * @param {number} [options.port] - broker listen port (0 = ephemeral)
 * @param {number} [options.stepMs=28] - ms between synthetic mouse steps
 * @param {boolean} [options.debug=false] - log connections and Input interception
 * @param {(params: {url?: string, background?: boolean, width?: number, height?: number}) => Promise<{targetId: string}>} [options.createTarget]
 *   Create a real built-in browser tab and return its CDP target id. Without it,
 *   Target.createTarget fails on Electron ("Not supported").
 * @returns {Promise<{ baseUrl: string, port: number, close: () => Promise<void> }>}
 */
export function createCdpBroker({ upstreamBaseUrl, port = 0, stepMs = 28, debug = false, createTarget = null, cursor = null, canExecute = null, canDiscover = null }) {
  const upstreamUrl = String(upstreamBaseUrl).replace(/\/$/, "");
  const upstreamWsOrigin = upstreamUrl.replace(/^http/, "ws");
  const log = (...args) => {
    if (debug) console.log("[cdp-broker]", ...args);
  };

  const targetConnections = new Map();
  let syntheticId = SYNTHETIC_ID_BASE;
  const httpServer = http.createServer();

  async function proxyJson(req, res) {
    let upstreamResponse;
    try {
      // The CDP upstream is the local Electron remote-debugging port.
      // loopback-fetch: 127.0.0.1/localhost only; never beyond loopback.
      upstreamResponse = await fetch(`${upstreamUrl}${req.url}`, { method: req.method });
    } catch (error) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `CDP upstream unreachable: ${error.message}` }));
      return;
    }
    let text = await upstreamResponse.text();
    if (canDiscover && (req.url.startsWith("/json/list") || req.url === "/json")) {
      try {
        const targets = JSON.parse(text);
        if (Array.isArray(targets)) {
          const allowed = await Promise.all(targets.map(async target => await canDiscover(target.id) ? target : null));
          text = JSON.stringify(allowed.filter(Boolean));
        }
      } catch {}
    }
    const brokerPort = serverPort(httpServer);
    const rewritten = text
      .replaceAll(`ws://127.0.0.1:${new URL(upstreamUrl).port}`, `ws://127.0.0.1:${brokerPort}`)
      .replaceAll(`ws://localhost:${new URL(upstreamUrl).port}`, `ws://127.0.0.1:${brokerPort}`);
    res.writeHead(upstreamResponse.status, {
      "content-type": upstreamResponse.headers.get("content-type") ?? "application/json",
      "cache-control": "no-store",
    });
    res.end(rewritten);
  }

  httpServer.on("request", (req, res) => {
    if (!req.url?.startsWith("/json")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    void proxyJson(req, res);
  });

  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (clientWs, req) => {
    const match = PROXY_PATH_RE.exec(new URL(req.url, "http://127.0.0.1").pathname);
    if (!match) {
      clientWs.close(1008, "unsupported path");
      return;
    }
    const targetPath = `${match[1] === "browser" ? "/devtools/browser" : "/devtools/page"}/${match[2]}`;
    const isPageSession = match[1] === "page";
    if (isPageSession) targetConnections.set(match[2], (targetConnections.get(match[2]) ?? 0) + 1);
    log(`connection: ${targetPath} (${isPageSession ? "page" : "browser-level"})`);
    const upstreamWs = new WebSocket(`${upstreamWsOrigin}${targetPath}`);

    const state = {
      // Browser-level connections (puppeteer/chrome-devtools-mcp) route page
      // commands through a sessionId; direct page connections use no sessionId.
      lastKnown: new Map(),
      attachedTargets: new Map(),
      owner: crypto.randomUUID(),
      closed: false, // sessionId -> { x, y }
      cursorScripts: new Map(),
      cursorInjected: new Set(), // sessionIds that have the ghost cursor script
      pendingSynthetic: new Map(), // syntheticId -> resolve
      clientReady: false,
      clientBuffer: [],
    };

    const forwardToClient = (data) => {
      if (clientWs.readyState === clientWs.OPEN) clientWs.send(typeof data === "string" ? data : data.toString());
    };

    const forwardToUpstream = (data) => {
      if (upstreamWs.readyState === upstreamWs.OPEN) upstreamWs.send(data);
    };

    // The page session a message targets: explicit sessionId on browser-level
    // connections, or null for a direct page connection.
    function pageSessionKey(msg) {
      if (isPageSession) return null;
      return msg?.sessionId ?? null;
    }

    function cursorTarget(sessionId) { return isPageSession ? match[2] : state.attachedTargets.get(sessionId); }

    function injectCursor(sessionId) {
      if (cursor) return cursor(cursorTarget(sessionId), { action: "present", owner: state.owner });
      if (state.cursorInjected.has(sessionId)) return Promise.resolve();
      state.cursorInjected.add(sessionId);
      return sendSynthetic("Page.enable", {}, sessionId).then(() => Promise.all([
        sendSynthetic("Page.addScriptToEvaluateOnNewDocument", { source: CURSOR_SCRIPT }, sessionId).then((result) => {
          if (result?.result?.identifier) state.cursorScripts.set(sessionId, result.result.identifier);
        }),
        sendSynthetic("Runtime.evaluate", { expression: CURSOR_SCRIPT }, sessionId),
      ])).catch(() => {
        state.cursorInjected.delete(sessionId);
      });
    }

    function moveCursor(x, y, sessionId) {
      if (cursor) return cursor(cursorTarget(sessionId), { action: "moveTo", x, y, animate: false, owner: state.owner });
      return sendSynthetic("Runtime.evaluate", {
        expression: "window.__sofiaAgentCursor && window.__sofiaAgentCursor.moveTo(" +
          `${Math.round(x)},${Math.round(y)});`,
      }, sessionId).catch(() => {});
    }

    function flashCursor(x, y, sessionId) {
      if (cursor) return cursor(cursorTarget(sessionId), { action: "flash", x, y, owner: state.owner });
      return sendSynthetic("Runtime.evaluate", {
        expression: "window.__sofiaAgentCursor && window.__sofiaAgentCursor.flash(" +
          `${Math.round(x)},${Math.round(y)});`,
      }, sessionId).catch(() => {});
    }

    function sendSynthetic(method, params, sessionId) {
      return new Promise((resolve) => {
        const id = (syntheticId += 1);
        const timeout = setTimeout(() => {
          if (state.pendingSynthetic.delete(id)) resolve(undefined);
        }, 3000);
        state.pendingSynthetic.set(id, (response) => {
          clearTimeout(timeout);
          resolve(response);
        });
        const payload = { id, method, params };
        if (sessionId != null) payload.sessionId = sessionId;
        forwardToUpstream(JSON.stringify(payload));
      });
    }

    async function dispatchMouse(msg) {
      const { params } = msg;
      const type = params?.type;
      if (type !== "mousePressed" && type !== "mouseMoved" && type !== "mouseReleased") return false;

      const x = Number(params.x);
      const y = Number(params.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return false;

      const sessionId = pageSessionKey(msg);
      const key = String(sessionId ?? "");
      let lastKnown = state.lastKnown.get(key) ?? null;

      // Replay eased hover steps from `from` to `target` so the page reacts
      // (hover styles, tooltips) and the ghost cursor visibly travels.
      async function replayMotion(from, target) {
        for (const point of humanPath(from, target)) {
          if (state.closed || (canExecute && !await canExecute(cursorTarget(sessionId), "Input.dispatchMouseEvent"))) throw new Error("Browser control belongs to the user. Wait for Resume agent.");
          await sendSynthetic("Input.dispatchMouseEvent", {
            type: "mouseMoved",
            x: point.x,
            y: point.y,
            button: "none",
            buttons: 0,
          }, sessionId);
          void moveCursor(point.x, point.y, sessionId);
          await sleep(stepMs);
        }
        // Ensure the cursor is exactly on target before the real event lands.
        void moveCursor(target.x, target.y, sessionId);
      }

      if (type === "mouseMoved") {
        const target = { x, y };
        if (lastKnown && dist(lastKnown, target) > 12) {
          await injectCursor(sessionId);
          await replayMotion(lastKnown, target);
        } else if (!lastKnown) {
          // First move on this page. The broker only sees raw CDP Input, so this
          // is all it knows: move where the client asked. Sofia's own semantic
          // cursor (apps/server/src/browser-cursor.mjs) is what decides where a
          // hover/click should appear.
          await injectCursor(sessionId);
          void moveCursor(x, y, sessionId);
        } else {
          void moveCursor(x, y, sessionId);
        }
        state.lastKnown.set(key, target);
        return false; // forward as-is; the CSS transition makes it glide
      }

      if (type === "mousePressed") {
        const target = { x, y };
        await injectCursor(sessionId);
        const from = lastKnown ?? { x: x - 90, y: y - 60 };
        const distance = dist(from, target);
        if (distance > 12) {
          await replayMotion(from, target);
        } else {
          void moveCursor(target.x, target.y, sessionId);
        }
        state.lastKnown.set(key, target);
        void flashCursor(x, y, sessionId);
        return false; // forward the press itself with its original id
      }

      return false; // mouseReleased: forward verbatim
    }

    async function handleClientMessage(data) {
      let msg;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      const targetId = cursorTarget(pageSessionKey(msg));
      if (msg.params?.targetId && msg.method !== "Target.createTarget" && canExecute && !await canExecute(msg.params.targetId, msg.method)) {
        forwardToClient(JSON.stringify({id:msg.id,error:{code:-32000,message:"Target is unavailable or controlled by the user."}})); return;
      }
      if (msg.method === "Sofia.cursor") {
        try {
          if (canExecute && msg.params?.action !== "hide" && !await canExecute(targetId, msg.method)) throw new Error("Browser control belongs to the user. Wait for Resume agent.");
          if (msg.params?.action === "moveTo") state.lastKnown.set(String(pageSessionKey(msg) ?? ""), {x:msg.params.x,y:msg.params.y});
          const result = cursor ? await cursor(targetId, {...msg.params, owner:state.owner}) : {host:false};
          forwardToClient(JSON.stringify({id:msg.id,result}));
        } catch(error) { forwardToClient(JSON.stringify({id:msg.id,error:{code:-32000,message:error.message}})); }
        return;
      }
      if (canExecute && targetId && !await canExecute(targetId, msg.method)) {
        forwardToClient(JSON.stringify({id:msg.id,error:{code:-32000,message:"Browser control belongs to the user. Wait for Resume agent."}}));
        return;
      }
      if (state.closed) return;
      if (msg.method === "Input.dispatchMouseEvent") {
        const handled = await dispatchMouse(msg);
        log("Input.dispatchMouseEvent", msg.params?.type, msg.params ? `(${Math.round(Number(msg.params.x))},${Math.round(Number(msg.params.y))})` : "", "session=" + (pageSessionKey(msg) ?? "-"));
        if (handled) return;
      } else if (msg.method === "Target.createTarget" && typeof createTarget === "function") {
        // Electron cannot create raw CDP targets ("Not supported"). Instead,
        // create a real visible built-in browser tab and answer the agent with
        // its target id, so new_page works and stays visible to the user.
        try {
          const { targetId } = await createTarget({
            url: msg.params?.url,
            background: Boolean(msg.params?.background),
          });
          forwardToClient(JSON.stringify({ id: msg.id, result: { targetId } }));
          log("Target.createTarget ->", targetId, msg.params?.url ?? "");
          return;
        } catch (error) {
          forwardToClient(JSON.stringify({
            id: msg.id,
            error: { code: -32000, message: `createTarget failed: ${error.message}` },
          }));
          return;
        }
      } else if (msg.method && pageSessionKey(msg) !== undefined) {
        // Non-Input activity on a page (navigate, snapshot, evaluate, etc.).
        // The connected-session overlay stays visible on each document.
        // Snapshots and evaluation never move an already visible pointer.
        // The broker cannot tell a read from an action, so it leaves the whole
        // question of where the cursor is to the semantic path.
        if (isActivityMethod(msg.method)) {
          await injectCursor(pageSessionKey(msg));
        }
      }
      forwardToUpstream(JSON.stringify(msg));
    }

    // Domains that reflect "the agent is doing something in the page".
    const ACTIVITY_METHOD_RE = /^(Page|DOM|Runtime|Accessibility|Network|Log|Emulation|Input)\./;
    function isActivityMethod(method) {
      return ACTIVITY_METHOD_RE.test(method) && method !== "Input.dispatchMouseEvent";
    }

    function queueCommand(data) {
      state.commandQueue = (state.commandQueue ?? Promise.resolve()).then(() => handleClientMessage(data)).catch(error => {
        try { const message = JSON.parse(String(data)); forwardToClient(JSON.stringify({id:message.id,error:{code:-32000,message:error.message}})); } catch {}
      });
    }
    clientWs.on("message", (data) => {
      if (!state.clientReady) {
        state.clientBuffer.push(data);
        return;
      }
      queueCommand(data);
    });
    clientWs.on("close", () => {
      state.closed = true;
      if (isPageSession) {
        const remaining = (targetConnections.get(match[2]) ?? 1) - 1;
        if (remaining > 0) targetConnections.set(match[2], remaining);
        else { targetConnections.delete(match[2]); if (cursor) void cursor(match[2], {action:"detach",owner:state.owner}); }
      }
      void (async () => {
        await Promise.allSettled([...state.cursorInjected].map(async (sessionId) => {
          await sendSynthetic("Runtime.evaluate", { expression: "window.__sofiaAgentCursor?.hide()" }, sessionId);
          const identifier = state.cursorScripts.get(sessionId);
          if (identifier) await sendSynthetic("Page.removeScriptToEvaluateOnNewDocument", { identifier }, sessionId);
        }));
        if (upstreamWs.readyState === upstreamWs.OPEN || upstreamWs.readyState === upstreamWs.CONNECTING) upstreamWs.close();
      })();
    });

    upstreamWs.on("open", () => {
      state.clientReady = true;
      if (isPageSession) void injectCursor(null);
      for (const buffered of state.clientBuffer.splice(0)) {
        queueCommand(buffered);
      }
    });
    upstreamWs.on("message", (data) => {
      let parsed;
      try {
        parsed = JSON.parse(String(data));
      } catch {
        forwardToClient(data);
        return;
      }
      if (parsed.method === "Target.attachedToTarget") state.attachedTargets.set(parsed.params.sessionId, parsed.params.targetInfo.targetId);
      if (parsed.method === "Page.domContentEventFired") {
        const sessionId = pageSessionKey(parsed);
        if (state.cursorInjected.has(sessionId)) {
          void sendSynthetic("Runtime.evaluate", { expression: CURSOR_SCRIPT }, sessionId);
        }
      }
      if (parsed.id != null && state.pendingSynthetic.has(parsed.id)) {
        const resolve = state.pendingSynthetic.get(parsed.id);
        state.pendingSynthetic.delete(parsed.id);
        resolve(parsed);
        return; // swallow synthetic responses, never forward to the agent
      }
      forwardToClient(data);
    });
    upstreamWs.on("error", () => {
      if (clientWs.readyState === clientWs.OPEN) clientWs.close(1011, "upstream error");
    });
    upstreamWs.on("close", () => {
      if (clientWs.readyState === clientWs.OPEN) clientWs.close(1011, "upstream closed");
    });
  });

  httpServer.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (!PROXY_PATH_RE.test(url.pathname)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  return /** @type {Promise<{ baseUrl: string, port: number, close: () => Promise<void> }>} */ (
    new Promise((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(port, "127.0.0.1", () => {
        const actualPort = serverPort(httpServer);
        resolve({
          baseUrl: `http://127.0.0.1:${actualPort}`,
          port: actualPort,
          close: () =>
            new Promise((resolveClose) => {
              for (const ws of wss.clients) {
                try { ws.close(); } catch { /* closing */ }
              }
              httpServer.close(() => resolveClose());
            }),
        });
      });
    })
  );
}
