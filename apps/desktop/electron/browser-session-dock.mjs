// A floating session dock over the expanded in-app browser.
//
// The browser page is a native `WebContentsView` painted above the React app,
// so no HTML from the main renderer can sit on top of it. Like the Peek shield,
// the dock is therefore its own transparent native view: one small page that
// owns the live turn status, a compact composer, and the controls that move,
// collapse, or leave the dock. It never resizes the page beneath it.
//
// Geometry is deliberately pure and exported: corners, zoom and collapse are
// policy, and `node --test` can prove them without an Electron window.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export const SESSION_DOCK_READY_CHANNEL = "sofia:browser:session-dock:ready";
export const SESSION_DOCK_STATE_CHANNEL = "sofia:browser:session-dock:state";
export const SESSION_DOCK_SUBMIT_CHANNEL = "sofia:browser:session-dock:submit";
export const SESSION_DOCK_STOP_CHANNEL = "sofia:browser:session-dock:stop";
export const SESSION_DOCK_LAYOUT_CHANNEL = "sofia:browser:session-dock:layout";
export const SESSION_DOCK_BACK_CHANNEL = "sofia:browser:session-dock:back-to-chat";
export const SESSION_DOCK_DRAG_CHANNEL = "sofia:browser:session-dock:drag";

export const SESSION_DOCK_SUBMIT_EVENT = "sofia:browser:session-dock-submit";
export const SESSION_DOCK_STOP_EVENT = "sofia:browser:session-dock-stop";
export const SESSION_DOCK_BACK_EVENT = "sofia:browser:session-dock-back-to-chat";

export const SESSION_DOCK_CORNERS = ["bottom-right", "bottom-left", "top-right"];
export const SESSION_DOCK_DEFAULT_LAYOUT = { corner: "bottom-right", collapsed: false };
/** Size in renderer CSS pixels; the window zoom scales it like every other rect. */
export const SESSION_DOCK_SIZE = {
  expanded: { width: 380, height: 132 },
  collapsed: { width: 220, height: 40 },
};
export const SESSION_DOCK_MARGIN = 16;

/** @param {unknown} value */
export function normalizeSessionDockCorner(value) {
  return SESSION_DOCK_CORNERS.includes(value) ? value : SESSION_DOCK_DEFAULT_LAYOUT.corner;
}

/** @param {unknown} value */
export function normalizeSessionDockLayout(value) {
  const candidate = value && typeof value === "object" ? value : {};
  return {
    corner: normalizeSessionDockCorner(candidate.corner),
    collapsed: candidate.collapsed === true,
  };
}

/** @param {boolean} collapsed */
export function sessionDockSize(collapsed) {
  return collapsed ? SESSION_DOCK_SIZE.collapsed : SESSION_DOCK_SIZE.expanded;
}

/**
 * Native view bounds for one corner.
 *
 * `windowWidth`/`windowHeight` are content bounds in device-independent
 * pixels. The dock is authored in CSS pixels, so its size and margin are
 * scaled by the main window's zoom factor exactly like renderer bounds are.
 * @param {{ windowWidth: number, windowHeight: number, zoom?: number, corner?: unknown, collapsed?: boolean, margin?: number }} input
 */
export function sessionDockBounds(input) {
  const windowWidth = Math.max(0, Math.round(Number(input?.windowWidth) || 0));
  const windowHeight = Math.max(0, Math.round(Number(input?.windowHeight) || 0));
  const zoom = Number.isFinite(input?.zoom) && Number(input.zoom) > 0 ? Number(input.zoom) : 1;
  const corner = normalizeSessionDockCorner(input?.corner);
  const size = sessionDockSize(input?.collapsed === true);
  const margin = Math.round((Number(input?.margin) || SESSION_DOCK_MARGIN) * zoom);
  const width = Math.min(windowWidth, Math.round(size.width * zoom));
  const height = Math.min(windowHeight, Math.round(size.height * zoom));
  const maxX = Math.max(0, windowWidth - width - margin);
  const maxY = Math.max(0, windowHeight - height - margin);
  return {
    x: corner.endsWith("right") ? maxX : Math.min(margin, maxX),
    y: corner.startsWith("top") ? Math.min(margin, maxY) : maxY,
    width,
    height,
  };
}

/**
 * One drag frame, clamped to the window. `dx`/`dy` are totals from the start
 * of the drag, not per-frame deltas, so a dropped frame cannot lose motion.
 * @param {{ rect: { x: number, y: number, width: number, height: number }, dx?: number, dy?: number, windowWidth: number, windowHeight: number }} input
 */
export function moveSessionDockBounds(input) {
  const rect = input.rect;
  const windowWidth = Math.max(0, Math.round(Number(input.windowWidth) || 0));
  const windowHeight = Math.max(0, Math.round(Number(input.windowHeight) || 0));
  const dx = Number.isFinite(input.dx) ? Number(input.dx) : 0;
  const dy = Number.isFinite(input.dy) ? Number(input.dy) : 0;
  const maxX = Math.max(0, windowWidth - rect.width);
  const maxY = Math.max(0, windowHeight - rect.height);
  return {
    x: Math.min(Math.max(0, Math.round(rect.x + dx)), maxX),
    y: Math.min(Math.max(0, Math.round(rect.y + dy)), maxY),
    width: Math.min(rect.width, windowWidth),
    height: Math.min(rect.height, windowHeight),
  };
}

/** The corner whose centre is nearest the released dock. */
export function nearestSessionDockCorner(input) {
  const rect = input.rect;
  const windowWidth = Math.max(0, Number(input.windowWidth) || 0);
  const windowHeight = Math.max(0, Number(input.windowHeight) || 0);
  const centerX = rect.x + rect.width / 2;
  const centerY = rect.y + rect.height / 2;
  const right = centerX >= windowWidth / 2;
  // Only three corners are offered; a top-left release becomes top-right.
  const top = centerY < windowHeight / 2;
  if (top) return "top-right";
  return right ? "bottom-right" : "bottom-left";
}

/**
 * A renderer-published turn snapshot, sanitized for the dock document.
 * @param {unknown} value
 * @param {unknown} layout
 */
export function normalizeSessionDockState(value, layout) {
  const candidate = value && typeof value === "object" ? value : {};
  const normalizedLayout = normalizeSessionDockLayout(layout);
  const tone = candidate.tone === "thinking" || candidate.tone === "warning" ? candidate.tone : "working";
  const mode = candidate.mode === "queue" || candidate.mode === "steer" || candidate.mode === "send"
    ? candidate.mode
    : candidate.running === true ? "steer" : "send";
  const meta = Array.isArray(candidate.meta)
    ? candidate.meta.filter((entry) => typeof entry === "string" && entry).slice(0, 4)
    : [];
  return {
    title: typeof candidate.title === "string" && candidate.title ? candidate.title.slice(0, 160) : "Sofia",
    tone,
    meta,
    note: typeof candidate.note === "string" ? candidate.note.slice(0, 240) : "",
    running: candidate.running === true,
    mode,
    dark: candidate.dark === true,
    corner: normalizedLayout.corner,
    collapsed: normalizedLayout.collapsed,
  };
}

const EMPTY_STATE = normalizeSessionDockState({}, SESSION_DOCK_DEFAULT_LAYOUT);

export function readSessionDockLayout(filePath) {
  try {
    return normalizeSessionDockLayout(JSON.parse(readFileSync(filePath, "utf8")));
  } catch {
    return { ...SESSION_DOCK_DEFAULT_LAYOUT };
  }
}

export function writeSessionDockLayout(filePath, layout) {
  try {
    mkdirSync(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.tmp`;
    writeFileSync(temporary, JSON.stringify(normalizeSessionDockLayout(layout)), { mode: 0o600 });
    renameSync(temporary, filePath);
  } catch {
    // Preferences are conveniences; a read-only profile must not break the dock.
  }
}

export const BROWSER_SESSION_DOCK_DOCUMENT = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  :root {
    --card-bg: rgba(250, 250, 251, 0.97);
    --card-border: rgba(15, 23, 42, 0.14);
    --card-text: #1d1d1f;
    --card-muted: #6e6e73;
    --card-soft: rgba(15, 23, 42, 0.06);
    --card-hover: rgba(15, 23, 42, 0.09);
    --card-accent: #3f63c8;
    --card-stop: #b42318;
    --sofia-blue: #3f63c8;
    --sofia-outline: rgba(15, 23, 42, 0.16);
  }
  :root[data-theme="dark"] {
    --card-bg: rgba(36, 37, 40, 0.97);
    --card-border: rgba(255, 255, 255, 0.14);
    --card-text: #f2f2f4;
    --card-muted: #a1a1a6;
    --card-soft: rgba(255, 255, 255, 0.08);
    --card-hover: rgba(255, 255, 255, 0.14);
    --card-accent: #a6bbff;
    --card-stop: #ff8a7a;
    --sofia-blue: #a6bbff;
    --sofia-outline: rgba(255, 255, 255, 0.18);
  }
  html, body {
    margin: 0; height: 100%; background: transparent; overflow: hidden;
    font: 500 12px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    -webkit-user-select: none; user-select: none; color: var(--card-text);
  }
  #card {
    box-sizing: border-box; height: 100%; padding: 9px 11px 8px;
    display: grid; grid-template-rows: auto auto auto; gap: 6px;
    background: var(--card-bg); border: 1px solid var(--card-border);
    border-radius: 14px; box-shadow: 0 12px 36px rgba(0, 0, 0, 0.22);
  }
  #card[hidden], #pill[hidden] { display: none; }
  header {
    display: flex; align-items: center; gap: 7px; min-width: 0; height: 20px;
    cursor: grab; touch-action: none;
  }
  header:active { cursor: grabbing; }
  .orbit {
    width: 13px; height: 13px; border-radius: 50%; flex-shrink: 0;
    background: conic-gradient(from 0deg, transparent 0 62%, var(--orbit-color) 100%);
    -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 2px), #000 calc(100% - 1.5px));
    mask: radial-gradient(farthest-side, transparent calc(100% - 2px), #000 calc(100% - 1.5px));
    box-shadow: inset 0 0 0 1.5px rgb(var(--dls-accent-rgb, 63 99 200) / .14);
    --orbit-color: var(--sofia-blue);
  }
  .orbit[data-tone="thinking"] { --orbit-color: #8b7cf6; }
  .orbit[data-tone="warning"] { --orbit-color: #d4a72c; }
  #card[data-running="false"] .orbit { animation: none; }
  @media (prefers-reduced-motion: no-preference) {
    #card[data-running="true"] .orbit { animation: sofia-orbit-spin .9s linear infinite; }
    .orbit[data-tone="warning"] { animation-duration: 1.6s; }
    @keyframes sofia-orbit-spin { to { transform: rotate(360deg); } }
  }
  .title {
    min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font-weight: 600; font-size: 12px;
  }
  #card[data-running="true"] .title {
    background: linear-gradient(90deg, var(--card-text) 0%, var(--card-muted) 45%, var(--card-text) 90%);
    background-size: 220% 100%; -webkit-background-clip: text; background-clip: text; color: transparent;
    animation: sofia-title-shimmer 1.8s linear infinite;
  }
  @media (prefers-reduced-motion: reduce) {
    #card[data-running="true"] .title { animation: none; color: var(--card-text); background: none; }
  }
  @keyframes sofia-title-shimmer { to { background-position: -220% 0; } }
  .meta {
    margin-left: auto; flex-shrink: 1; min-width: 0; max-width: 45%;
    overflow: hidden; text-overflow: ellipsis; color: var(--card-muted);
    font-weight: 500; font-size: 11px; white-space: nowrap;
  }
  .icon-button {
    display: inline-flex; align-items: center; justify-content: center;
    width: 20px; height: 20px; padding: 0; border: 0; border-radius: 6px;
    background: transparent; color: var(--card-muted); cursor: pointer; font: inherit;
  }
  .icon-button:hover { background: var(--card-hover); color: var(--card-text); }
  .icon-button:focus-visible, button:focus-visible, textarea:focus-visible {
    outline: 2px solid var(--card-accent); outline-offset: 1px;
  }
  .icon-button[aria-pressed="true"] { background: var(--card-soft); color: var(--card-text); }
  .note {
    margin: 0 1px; color: var(--card-muted); font-size: 11px; line-height: 14px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .note[hidden] { display: none; }
  .composer { display: flex; align-items: center; gap: 6px; min-width: 0; }
  textarea {
    box-sizing: border-box; flex: 1; min-width: 0; height: 30px; max-height: 54px;
    resize: none; padding: 7px 9px; border-radius: 8px;
    border: 1px solid var(--card-border); background: var(--card-soft); color: var(--card-text);
    font: inherit; font-size: 12px; line-height: 16px; outline: none;
    -webkit-user-select: text; user-select: text;
  }
  textarea::placeholder { color: var(--card-muted); }
  .primary, .stop, .ghost {
    height: 28px; border-radius: 8px; border: 0; padding: 0 10px;
    font: inherit; font-size: 11px; font-weight: 600; cursor: pointer; white-space: nowrap;
  }
  .primary { background: var(--card-accent); color: #fff; }
  :root[data-theme="dark"] .primary { color: #15161a; }
  .primary:disabled { opacity: .45; cursor: default; }
  .stop { background: transparent; border: 1px solid var(--card-border); color: var(--card-stop); }
  .stop[hidden] { display: none; }
  .stop:hover { background: var(--card-hover); }
  footer {
    display: flex; align-items: center; gap: 5px; min-width: 0;
  }
  .corners { display: flex; gap: 2px; }
  .corners .icon-button { font-size: 12px; }
  .ghost {
    margin-left: auto; height: 22px; padding: 0 8px; background: transparent;
    color: var(--card-muted); font-weight: 500;
  }
  .ghost:hover { background: var(--card-hover); color: var(--card-text); }
  #pill {
    box-sizing: border-box; height: 100%; display: flex; align-items: center; gap: 8px;
    padding: 0 13px; background: var(--card-bg); border: 1px solid var(--card-border);
    border-radius: 999px; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.20); cursor: pointer;
  }
  #pill:hover { background: var(--card-hover); }
  #pill .title { font-size: 12px; }
  #pill .meta { margin-left: auto; }
</style></head>
<body>
  <div id="card" data-running="false" role="region" aria-label="Sofia session dock">
    <header id="drag">
      <span class="orbit" id="orbit" aria-hidden="true"></span>
      <span class="title" id="title">Sofia</span>
      <span class="meta" id="meta"></span>
      <button class="icon-button" data-action="collapse" aria-label="Collapse session dock" title="Collapse">&#8211;</button>
    </header>
    <div class="note" id="note" hidden></div>
    <div class="composer">
      <textarea id="input" rows="1" placeholder="Ask or steer…" aria-label="Message Sofia"></textarea>
      <button class="stop" id="stop" data-action="stop" hidden>Stop</button>
      <button class="primary" id="send" data-action="submit">Send</button>
    </div>
    <footer>
      <div class="corners" role="group" aria-label="Dock corner">
        <button class="icon-button" data-corner="bottom-left" aria-label="Dock bottom left" title="Bottom left">&#8601;</button>
        <button class="icon-button" data-corner="bottom-right" aria-label="Dock bottom right" title="Bottom right">&#8600;</button>
        <button class="icon-button" data-corner="top-right" aria-label="Dock top right" title="Top right">&#8599;</button>
      </div>
      <button class="ghost" data-action="back-to-chat">Back to chat</button>
    </footer>
  </div>
  <div id="pill" hidden role="button" tabindex="0" aria-label="Expand session dock">
    <span class="orbit" id="pill-orbit" aria-hidden="true"></span>
    <span class="title" id="pill-title">Sofia</span>
    <span class="meta" id="pill-meta"></span>
  </div>
  <script>
    (function () {
      var api = window.__SOFIA_BROWSER_SESSION_DOCK__;
      var root = document.documentElement;
      var card = document.getElementById("card");
      var pill = document.getElementById("pill");
      var title = document.getElementById("title");
      var meta = document.getElementById("meta");
      var note = document.getElementById("note");
      var orbit = document.getElementById("orbit");
      var pillTitle = document.getElementById("pill-title");
      var pillMeta = document.getElementById("pill-meta");
      var pillOrbit = document.getElementById("pill-orbit");
      var input = document.getElementById("input");
      var send = document.getElementById("send");
      var stop = document.getElementById("stop");
      var header = document.getElementById("drag");
      var latest = { corner: "bottom-right", collapsed: false, mode: "send", running: false };

      function apply(state) {
        latest = state || latest;
        root.dataset.theme = latest.dark ? "dark" : "light";
        card.dataset.running = latest.running ? "true" : "false";
        title.textContent = latest.title || "Sofia";
        meta.textContent = (latest.meta || []).join(" · ");
        note.textContent = latest.note || "";
        note.hidden = !latest.note;
        orbit.dataset.tone = latest.tone || "working";
        pillOrbit.dataset.tone = latest.tone || "working";
        pillTitle.textContent = latest.title || "Sofia";
        pillMeta.textContent = latest.running ? (latest.meta || []).join(" · ") : "";
        send.textContent = latest.mode === "queue" ? "Queue" : latest.mode === "steer" ? "Steer" : "Send";
        send.setAttribute("aria-label", latest.mode === "queue" ? "Queue message" : latest.mode === "steer" ? "Steer the running turn" : "Send message");
        send.disabled = !input.value.trim();
        stop.hidden = !latest.running;
        card.dataset.collapsed = latest.collapsed ? "true" : "false";
        card.hidden = Boolean(latest.collapsed);
        pill.hidden = !latest.collapsed;
        Array.prototype.forEach.call(document.querySelectorAll("[data-corner]"), function (button) {
          button.setAttribute("aria-pressed", button.getAttribute("data-corner") === latest.corner ? "true" : "false");
        });
      }

      function submit() {
        var text = input.value.trim();
        if (!text) return;
        input.value = "";
        send.disabled = true;
        if (api) api.submit(text, latest.mode || "send");
        input.focus();
      }

      function setCollapsed(collapsed) {
        if (!api) return;
        api.setLayout({ corner: latest.corner, collapsed: collapsed });
      }

      input.addEventListener("input", function () {
        send.disabled = !input.value.trim();
        input.style.height = "30px";
        input.style.height = Math.min(54, input.scrollHeight) + "px";
      });
      input.addEventListener("keydown", function (event) {
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          submit();
        }
      });

      document.addEventListener("click", function (event) {
        var target = event.target && event.target.closest ? event.target.closest("[data-action], [data-corner]") : null;
        if (!target) return;
        var corner = target.getAttribute("data-corner");
        if (corner) {
          if (api) api.setLayout({ corner: corner, collapsed: latest.collapsed });
          return;
        }
        var action = target.getAttribute("data-action");
        if (action === "submit") submit();
        else if (action === "stop") api && api.stop();
        else if (action === "collapse") setCollapsed(true);
        else if (action === "back-to-chat") api && api.backToChat();
      });

      function expand() {
        if (latest.collapsed) setCollapsed(false);
      }
      pill.addEventListener("click", expand);
      pill.addEventListener("keydown", function (event) {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          expand();
        }
      });

      var drag = null;
      header.addEventListener("pointerdown", function (event) {
        if (event.button !== 0) return;
        if (event.target && event.target.closest && event.target.closest("button")) return;
        drag = { id: event.pointerId, x: event.screenX, y: event.screenY };
        header.setPointerCapture(event.pointerId);
        if (api) api.dragBy(0, 0, "start");
      });
      header.addEventListener("pointermove", function (event) {
        if (!drag || event.pointerId !== drag.id) return;
        if (api) api.dragBy(event.screenX - drag.x, event.screenY - drag.y, "move");
      });
      function endDrag(event, cancelled) {
        if (!drag || event.pointerId !== drag.id) return;
        if (api) api.dragBy(event.screenX - drag.x, event.screenY - drag.y, cancelled ? "cancel" : "end");
        drag = null;
      }
      header.addEventListener("pointerup", function (event) { endDrag(event, false); });
      header.addEventListener("pointercancel", function (event) { endDrag(event, true); });

      if (api) {
        api.onState(apply);
        api.ready();
      }
    })();
  </script>
</body></html>`;

export function browserSessionDockUrl() {
  // The fragment keeps the internal dock out of the agent-drivable page list,
  // exactly like the Peek shield's marker.
  return `data:text/html;charset=utf-8,${encodeURIComponent(BROWSER_SESSION_DOCK_DOCUMENT)}#sofia-internal-session-dock`;
}

/**
 * @typedef {{ x: number, y: number, width: number, height: number }} DockRect
 * @typedef {{
 *   webContents: {
 *     isDestroyed: () => boolean,
 *     setWindowOpenHandler: (handler: () => { action: "deny" }) => void,
 *     once: (event: string, callback: () => void) => void,
 *     loadURL: (url: string) => Promise<unknown>,
 *     send: (channel: string, payload: unknown) => void,
 *     close: () => void,
 *   },
 *   setBackgroundColor?: (color: string) => void,
 *   setVisible?: (visible: boolean) => void,
 *   getBounds: () => DockRect,
 *   setBounds: (bounds: DockRect) => void,
 * }} DockView
 * @typedef {{
 *   getContentSize?: () => [number, number],
 *   contentView: {
 *     children: unknown[],
 *     addChildView: (view: DockView) => void,
 *     removeChildView: (view: DockView) => void,
 *   },
 * }} DockWindow
 */

/**
 * Native dock lifecycle. Electron types stay out of this module: the caller
 * supplies the `WebContentsView` factory, which keeps the geometry functions
 * above testable under plain Node.
 *
 * @param {{
 *   getWindow: () => DockWindow | null,
 *   getHost?: () => (DockWindow["contentView"] & { getBounds: () => { width: number, height: number } }) | null,
 *   getZoomFactor: () => number,
 *   createView: () => DockView,
 *   bringToTop: (view: DockView) => void,
 *   sendToRenderer: (channel: string, payload?: unknown) => void,
 *   preferencesPath: string,
 * }} options
 */
export function createBrowserSessionDock({
  getWindow,
  getHost,
  getZoomFactor,
  createView,
  bringToTop,
  sendToRenderer,
  preferencesPath,
}) {
  /** @type {DockView | null} */
  let view = null;
  let ready = false;
  let attached = false;
  let visible = false;
  let layout = readSessionDockLayout(preferencesPath);
  let state = EMPTY_STATE;
  /** @type {{ x: number, y: number, width: number, height: number } | null} */
  let dragStart = null;

  /** The view the dock lives in: the active browser container when there is one. */
  let parent = null;

  function contentSize() {
    const host = getHost?.();
    if (host) {
      const { width, height } = host.getBounds();
      return { width, height };
    }
    const mainWindow = getWindow();
    const [width, height] = mainWindow?.getContentSize?.() ?? [0, 0];
    return { width, height };
  }

  // Host the dock inside the browser's own container, after the page view, so
  // it is always drawn above the page. As a sibling of the container in the
  // window, any re-attach of the browser could stack the page over it.
  function placeInHost(dock, mainWindow) {
    const next = getHost?.() ?? mainWindow.contentView;
    if (parent && parent !== next) {
      try { if (parent.children.includes(dock)) parent.removeChildView(dock); } catch { /* already gone */ }
    }
    parent = next;
    const children = next.children;
    if (children.at(-1) === dock) return;
    try { if (children.includes(dock)) next.removeChildView(dock); } catch { /* already gone */ }
    next.addChildView(dock);
  }

  function bounds() {
    const { width, height } = contentSize();
    return sessionDockBounds({
      windowWidth: width,
      windowHeight: height,
      zoom: getZoomFactor(),
      corner: layout.corner,
      collapsed: layout.collapsed,
    });
  }

  function ensureView() {
    if (view && !view.webContents.isDestroyed()) return view;
    view = createView();
    view.setBackgroundColor?.("#00000000");
    view.setVisible?.(false);
    view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    view.webContents.once("destroyed", () => {
      view = null;
      ready = false;
      attached = false;
      visible = false;
    });
    ready = false;
    void view.webContents.loadURL(browserSessionDockUrl());
    return view;
  }

  function payload() {
    return normalizeSessionDockState(state, layout);
  }

  function sendState() {
    if (!view || !ready || view.webContents.isDestroyed()) return;
    view.webContents.send(SESSION_DOCK_STATE_CHANNEL, payload());
  }

  function updateBounds() {
    if (!view || !visible || view.webContents.isDestroyed()) return;
    const next = bounds();
    const current = view.getBounds();
    if (current.x === next.x && current.y === next.y && current.width === next.width && current.height === next.height) return;
    view.setBounds(next);
  }

  function persist() {
    writeSessionDockLayout(preferencesPath, layout);
  }

  function show() {
    const mainWindow = getWindow();
    if (!mainWindow) return;
    const dock = ensureView();
    try {
      placeInHost(dock, mainWindow);
    } catch {
      return;
    }
    attached = true;
    if (!visible) {
      dock.setVisible?.(true);
      visible = true;
    }
    updateBounds();
    // Inside the window (no browser container yet) the dock still has to beat
    // the other native views to the top.
    if (parent === mainWindow.contentView) bringToTop(dock);
    sendState();
  }

  function hide() {
    if (!view || view.webContents.isDestroyed()) {
      visible = false;
      return;
    }
    view.setVisible?.(false);
    visible = false;
    dragStart = null;
  }

  function setState(next) {
    state = next ?? state;
    sendState();
    return true;
  }

  function setLayout(next) {
    const merged = normalizeSessionDockLayout({
      corner: next?.corner ?? layout.corner,
      collapsed: next?.collapsed ?? layout.collapsed,
    });
    if (merged.corner === layout.corner && merged.collapsed === layout.collapsed) {
      sendState();
      return layout;
    }
    layout = merged;
    persist();
    updateBounds();
    sendState();
    return layout;
  }

  function dragBy(dx, dy, phase) {
    const mainWindow = getWindow();
    if (!mainWindow || !visible || !view || view.webContents.isDestroyed()) return layout;
    const { width: windowWidth, height: windowHeight } = contentSize();
    if (!dragStart) dragStart = view.getBounds();
    const next = moveSessionDockBounds({ rect: dragStart, dx, dy, windowWidth, windowHeight });
    if (phase !== "end" && phase !== "cancel") {
      view.setBounds(next);
      return layout;
    }
    const corner = nearestSessionDockCorner({ rect: next, windowWidth, windowHeight });
    dragStart = null;
    layout = normalizeSessionDockLayout({ corner, collapsed: layout.collapsed });
    persist();
    updateBounds();
    sendState();
    return layout;
  }

  function markReady(sender) {
    if (!view || sender !== view.webContents) return false;
    ready = true;
    sendState();
    return true;
  }

  function isSender(sender) {
    return Boolean(view && !view.webContents.isDestroyed() && sender === view.webContents);
  }

  function handleAction(channel, payloadValue, sender) {
    if (!isSender(sender)) return false;
    if (channel === SESSION_DOCK_SUBMIT_CHANNEL) {
      const text = typeof payloadValue?.text === "string" ? payloadValue.text.trim().slice(0, 8000) : "";
      if (!text) return false;
      const mode = payloadValue?.mode === "queue" || payloadValue?.mode === "steer" ? payloadValue.mode : "send";
      sendToRenderer(SESSION_DOCK_SUBMIT_EVENT, { text, mode });
      return true;
    }
    if (channel === SESSION_DOCK_STOP_CHANNEL) {
      sendToRenderer(SESSION_DOCK_STOP_EVENT);
      return true;
    }
    if (channel === SESSION_DOCK_BACK_CHANNEL) {
      sendToRenderer(SESSION_DOCK_BACK_EVENT);
      return true;
    }
    if (channel === SESSION_DOCK_LAYOUT_CHANNEL) {
      setLayout(payloadValue);
      return true;
    }
    if (channel === SESSION_DOCK_DRAG_CHANNEL) {
      dragBy(payloadValue?.dx, payloadValue?.dy, payloadValue?.phase);
      return true;
    }
    return false;
  }

  function destroy() {
    const dock = view;
    view = null;
    ready = false;
    attached = false;
    visible = false;
    dragStart = null;
    if (dock && parent) {
      try {
        if (parent.children.includes(dock)) parent.removeChildView(dock);
      } catch {
        // already gone
      }
    }
    parent = null;
    try { dock?.webContents.close(); } catch { /* already destroyed */ }
  }

  return {
    show,
    hide,
    setState,
    setLayout,
    dragBy,
    markReady,
    isSender,
    handleAction,
    getLayout: () => ({ ...layout }),
    isVisible: () => visible,
    destroy,
  };
}
