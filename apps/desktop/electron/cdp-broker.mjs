// CDP broker: an engine-agnostic proxy that sits between an agent (OpenCode,
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
// backward compatible for OpenCode and equally reusable for a future Codex
// runtime.
import http from "node:http";
import { WebSocket, WebSocketServer } from "ws";

const PROXY_PATH_RE = /^\/devtools\/(page|browser)\/([^/?]+)(?:\?.*)?$/;
const SYNTHETIC_ID_BASE = 1_000_000_000;

// Injected into every new document of a driven target. Creates (once) a fixed,
// pointer-transparent ghost cursor and exposes a tiny controller the broker
// drives via Runtime.evaluate. The cursor uses high-contrast colors (white ring
// with a black outline) so it is visible on any background — no blend modes.
// `__openworkAgentCursor` guard makes repeated injection a no-op even across
// multiple CDP sessions sharing the page.
// Cursor SVG — a hand-drawn mouse, recolored (white body) so it stays visible on
// dark pages, with a neon under-aura and a subtle idle wobble/breath so the agent
// cursor feels alive (mirrors the ChatGPT desktop cursor).
const CURSOR_MOUSE_PATH = "m151 41.78c-3.03 0.99-7.53 2.97-10 4.4-2.47 1.43-6.86 5.13-9.75 8.21-2.89 3.09-6.45 8.2-7.91 11.36-1.46 3.16-3.09 8.45-3.62 11.75-0.74 4.55 0.74 41.29 6.12 152.5 3.9 80.58 7.49 150.77 7.98 156 0.61 6.49 1.69 11.24 3.4 15 1.37 3.02 4.48 7.69 6.89 10.36 2.91 3.22 6.9 6.09 11.84 8.5 6.92 3.38 8.08 3.64 16.5 3.6 6.85-0.02 10.39-0.56 14.55-2.2 3.03-1.19 7.71-4.09 10.41-6.46 2.7-2.36 16.95-20.28 31.67-39.8 14.72-19.52 29.39-38.09 32.59-41.25 3.21-3.16 8.53-7.55 11.83-9.75 3.3-2.2 9.15-5.32 13-6.92 3.85-1.6 10.49-3.62 14.75-4.5 6.43-1.31 15.89-1.58 55.5-1.59 39.26-0.01 48.73-0.28 53.25-1.51 3.02-0.82 7.52-2.72 10-4.2 2.48-1.49 6.19-4.41 8.25-6.49 2.06-2.09 4.81-5.93 6.11-8.54 1.3-2.61 2.94-7.23 3.64-10.25 0.77-3.31 1.02-7.79 0.64-11.25-0.35-3.16-1.52-8.11-2.59-11-1.07-2.89-3.88-7.46-6.25-10.16-2.36-2.71-54.25-46.16-115.3-96.57-61.05-50.41-114.6-94.56-119-98.1-4.4-3.54-10.93-7.75-14.5-9.34-5.25-2.34-8.23-2.97-15.5-3.25-6.72-0.26-10.39 0.1-14.5 1.45z";
const CURSOR_SCRIPT = `(() => {
  if (window.__openworkAgentCursor) return;
  let el = null, aura = null, mouse = null;
  const S = 30; // rendered cursor size (px)
  const ensure = () => {
    if (el && el.isConnected) return el;
    el = document.createElement("div");
    el.id = "__openwork-agent-cursor";
    el.setAttribute("aria-hidden", "true");
    const st = el.style;
    st.position = "fixed"; st.top = "0"; st.left = "0";
    st.width = S + "px"; st.height = S + "px";
    st.margin = "0"; st.padding = "0"; st.border = "0";
    st.zIndex = "2147483647"; st.pointerEvents = "none";
    st.transform = "translate(0px,0px)"; st.opacity = "0";
    st.transition = "transform 130ms cubic-bezier(.2,.7,.3,1), opacity 200ms ease-out";
    st.willChange = "transform, opacity";
    el.innerHTML =
      '<style>' +
      '@keyframes owAura{0%,100%{opacity:.55;transform:scale(1)}50%{opacity:1;transform:scale(1.12)}}' +
      '@keyframes owWob{0%,100%{transform:rotate(-3.5deg) translateX(-0.4px)}50%{transform:rotate(4deg) translateX(0.6px)}}' +
      '@keyframes owHue{0%{filter:blur(3px) hue-rotate(0deg)}100%{filter:blur(3px) hue-rotate(360deg)}}' +
      '</style>' +
      '<div style="position:absolute;inset:-10px;border-radius:50%;background:radial-gradient(circle, rgba(56,189,248,.42), rgba(168,85,247,.22) 52%, rgba(0,0,0,0) 72%);filter:blur(4px);animation:owAura 3.4s ease-in-out infinite, owHue 7s linear infinite"></div>' +
      '<svg id="__ow-mouse" viewBox="0 0 512 512" width="' + S + '" height="' + S + '" ' +
        'style="position:absolute;inset:0;animation:owWob 2.8s ease-in-out infinite;transform-origin:50% 50%;filter:drop-shadow(0 0 2px rgba(255,255,255,.7)) drop-shadow(0 0 7px rgba(56,189,248,.65))">' +
        '<path fill="rgba(255,255,255,.96)" stroke="rgba(10,12,20,.55)" stroke-width="16" stroke-linejoin="round" d="' + '${CURSOR_MOUSE_PATH}' + '"/>' +
      '</svg>';
    (document.documentElement || document).appendChild(el);
    aura = el.firstElementChild.nextElementSibling ? el.firstElementChild.nextElementSibling : null;
    mouse = el.querySelector("#__ow-mouse");
    return el;
  };
  let wobbleT = null;
  const place = (e, x, y, scale) => {
    const s = scale || 1;
    e.style.opacity = "1";
    e.style.transform = "translate(" + (Math.round(x) - S / 2) + "px," + (Math.round(y) - S / 2) + "px) scale(" + s + ")";
  };
  const burst = (x, y) => {
    const e = ensure();
    e.style.transition = "transform 120ms cubic-bezier(.2,.6,.3,1), opacity 260ms ease-out";
    e.style.opacity = "1";
    e.style.transform = "translate(" + (Math.round(x) - S / 2) + "px," + (Math.round(y) - S / 2) + "px) scale(0.7)";
    requestAnimationFrame(() => {
      e.style.transform = "translate(" + (Math.round(x) - S / 2) + "px," + (Math.round(y) - S / 2) + "px) scale(1.22)";
    });
    setTimeout(() => { if (el && el.isConnected) { el.style.transform = "translate(" + (Math.round(x) - S / 2) + "px," + (Math.round(y) - S / 2) + "px) scale(1)"; } }, 150);
  };
  window.__openworkAgentCursor = {
    present() {
      const e = ensure();
      const cx = Math.round((window.innerWidth || 640) / 2);
      const cy = Math.round((window.innerHeight || 480) / 2);
      place(e, cx, cy);
      return cx + "," + cy;
    },
    moveTo(x, y) {
      const e = ensure();
      place(e, x, y);
      // A brief extra wobble on movement so the cursor feels alive.
      clearTimeout(wobbleT);
      if (mouse) { mouse.style.animation = "none"; void mouse.offsetWidth; mouse.style.animation = "owWob 0.8s ease-in-out 2"; }
      wobbleT = setTimeout(() => { if (mouse) mouse.style.animation = "owWob 2.8s ease-in-out infinite"; }, 1400);
    },
    flash(x, y) { burst(x, y); },
    hide() { if (el && el.isConnected) el.style.opacity = "0"; clearTimeout(wobbleT); },
  };
})();`;

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
export function createCdpBroker({ upstreamBaseUrl, port = 0, stepMs = 28, debug = false, createTarget = null }) {
  const upstreamUrl = String(upstreamBaseUrl).replace(/\/$/, "");
  const upstreamWsOrigin = upstreamUrl.replace(/^http/, "ws");
  const log = (...args) => {
    if (debug) console.log("[cdp-broker]", ...args);
  };

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
    const text = await upstreamResponse.text();
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
    log(`connection: ${targetPath} (${isPageSession ? "page" : "browser-level"})`);
    const upstreamWs = new WebSocket(`${upstreamWsOrigin}${targetPath}`);

    const state = {
      // Browser-level connections (puppeteer/chrome-devtools-mcp) route page
      // commands through a sessionId; direct page connections use no sessionId.
      lastKnown: new Map(), // sessionId -> { x, y }
      cursorInjected: new Set(), // sessionIds that have the ghost cursor script
      presented: new Set(), // sessionIds whose center-present already happened
      pendingSynthetic: new Map(), // syntheticId -> resolve
      clientReady: false,
      clientBuffer: [],
    };

    const forwardToClient = (data) => {
      if (clientWs.readyState === clientWs.OPEN) clientWs.send(data);
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

    function injectCursor(sessionId) {
      if (state.cursorInjected.has(sessionId)) return Promise.resolve();
      state.cursorInjected.add(sessionId);
      return Promise.all([
        sendSynthetic("Page.addScriptToEvaluateOnNewDocument", { source: CURSOR_SCRIPT }, sessionId),
        sendSynthetic("Runtime.evaluate", { expression: CURSOR_SCRIPT }, sessionId),
      ]).catch(() => {
        // Page may be mid-navigation; harmless to skip until next document.
      });
    }

    function moveCursor(x, y, sessionId) {
      return sendSynthetic("Runtime.evaluate", {
        expression: "window.__openworkAgentCursor && window.__openworkAgentCursor.moveTo(" +
          `${Math.round(x)},${Math.round(y)});`,
      }, sessionId).catch(() => {});
    }

    function flashCursor(x, y, sessionId) {
      return sendSynthetic("Runtime.evaluate", {
        expression: "window.__openworkAgentCursor && window.__openworkAgentCursor.flash(" +
          `${Math.round(x)},${Math.round(y)});`,
      }, sessionId).catch(() => {});
    }

    // Show the ghost cursor at the page center so the user can always see where
    // the agent is working, even when it only navigates/snapshots/evaluates.
    // Resolves to the center coordinates so the first mouse move can glide
    // from center to its target.
    function presentCursor(sessionId) {
      return sendSynthetic("Runtime.evaluate", {
        expression: "window.__openworkAgentCursor && window.__openworkAgentCursor.present()",
        returnByValue: true,
      }, sessionId).then(({ result }) => {
        const value = result?.result?.value;
        if (typeof value === "string") {
          const [cx, cy] = value.split(",").map(Number);
          if (Number.isFinite(cx) && Number.isFinite(cy)) return { x: cx, y: cy };
        }
        return null;
      }).catch(() => null);
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
        } else if (!lastKnown && !state.presented.has(key)) {
          // First move on this page: glide from the page center (where the
          // ghost cursor is presented) to the target so the user sees the
          // cursor arrive on the element before any click lands.
          state.presented.add(key);
          await injectCursor(sessionId);
          const center = await presentCursor(sessionId);
          if (center && dist(center, target) > 12) {
            await replayMotion(center, target);
          } else {
            void moveCursor(x, y, sessionId);
          }
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
        // Only present the ghost cursor once per page (first activity) and
        // again after a navigation — never on every snapshot/eval, which would
        // constantly yank the cursor back to the page center.
        if (isActivityMethod(msg.method)) {
          const sessionId = pageSessionKey(msg);
          const key = String(sessionId ?? "");
          const isNavigation = NAVIGATION_METHOD_RE.test(msg.method);
          if (isNavigation || !state.presented.has(key)) {
            state.presented.add(key);
            await injectCursor(sessionId);
            void presentCursor(sessionId);
          } else {
            await injectCursor(sessionId);
          }
        }
      }
      forwardToUpstream(JSON.stringify(msg));
    }

    // Domains that reflect "the agent is doing something in the page".
    const ACTIVITY_METHOD_RE = /^(Page|DOM|Runtime|Accessibility|Network|Log|Emulation|Input)\./;
    const NAVIGATION_METHOD_RE = /^(Page\.(navigate|reload|goBack|goForward|navigateToHistoryEntry))$/;
    function isActivityMethod(method) {
      return ACTIVITY_METHOD_RE.test(method) && method !== "Input.dispatchMouseEvent";
    }

    clientWs.on("message", (data) => {
      if (!state.clientReady) {
        state.clientBuffer.push(data);
        return;
      }
      void handleClientMessage(data);
    });
    clientWs.on("close", () => {
      if (upstreamWs.readyState === upstreamWs.OPEN || upstreamWs.readyState === upstreamWs.CONNECTING) {
        upstreamWs.close();
      }
    });

    upstreamWs.on("open", () => {
      state.clientReady = true;
      for (const buffered of state.clientBuffer.splice(0)) {
        void handleClientMessage(buffered);
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
