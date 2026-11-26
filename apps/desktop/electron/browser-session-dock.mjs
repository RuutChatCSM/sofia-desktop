// A floating session dock over the expanded in-app browser.
//
// The browser page is a native `WebContentsView` painted above the React app,
// so the dock is its own transparent native view. It loads the same app on the
// `#/dock` route: the real transcript and composer in a compact shell. This
// module owns only native policy — geometry, persistence, navigation, and which
// webContents may drive it. It never hides or shows the view to resize.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export const SESSION_DOCK_READY_CHANNEL = "sofia:browser:session-dock:ready";
export const SESSION_DOCK_LAYOUT_CHANNEL = "sofia:browser:session-dock:layout";
export const SESSION_DOCK_LAYOUT_STATE_CHANNEL = "sofia:browser:session-dock:layout-state";
export const SESSION_DOCK_THEME_CHANNEL = "sofia:browser:session-dock:theme";
export const SESSION_DOCK_BACK_CHANNEL = "sofia:browser:session-dock:back-to-chat";
export const SESSION_DOCK_SIDEBAR_CHANNEL = "sofia:browser:session-dock:open-sidebar";
export const SESSION_DOCK_DRAG_CHANNEL = "sofia:browser:session-dock:drag";

export const SESSION_DOCK_BACK_EVENT = "sofia:browser:session-dock-back-to-chat";
export const SESSION_DOCK_SIDEBAR_EVENT = "sofia:browser:session-dock-open-sidebar";

export const SESSION_DOCK_CORNERS = ["bottom-right", "bottom-left", "top-right"];
export const SESSION_DOCK_SIZES = ["panel", "bar", "bubble"];
export const SESSION_DOCK_DEFAULT_LAYOUT = { corner: "bottom-right", size: "panel" };
/** Size in renderer CSS pixels; the window zoom scales it like every other rect. */
export const SESSION_DOCK_SIZE = {
  panel: { width: 440, height: 620 },
  bar: { width: 560, height: 96 },
  bubble: { width: 56, height: 56 },
};
export const SESSION_DOCK_MARGIN = 16;

/** @param {unknown} value */
export function normalizeSessionDockCorner(value) {
  return SESSION_DOCK_CORNERS.includes(value) ? value : SESSION_DOCK_DEFAULT_LAYOUT.corner;
}

/** @param {unknown} value */
export function normalizeSessionDockSize(value) {
  return SESSION_DOCK_SIZES.includes(value) ? value : SESSION_DOCK_DEFAULT_LAYOUT.size;
}

/** @param {unknown} value */
export function normalizeSessionDockLayout(value) {
  const candidate = value && typeof value === "object" ? value : {};
  // Older profiles stored a boolean; treat a collapsed dock as the bubble.
  const legacySize = candidate.collapsed === true ? "bubble" : undefined;
  return {
    corner: normalizeSessionDockCorner(candidate.corner),
    size: candidate.size === undefined ? legacySize ?? SESSION_DOCK_DEFAULT_LAYOUT.size : normalizeSessionDockSize(candidate.size),
  };
}

/** @param {unknown} size */
export function sessionDockSize(size) {
  return SESSION_DOCK_SIZE[normalizeSessionDockSize(size)];
}

/**
 * Native view bounds for one corner.
 *
 * `windowWidth`/`windowHeight` are content bounds in device-independent
 * pixels. The dock is authored in CSS pixels, so its size and margin are
 * scaled by the main window's zoom factor exactly like renderer bounds are.
 * @param {{ windowWidth: number, windowHeight: number, zoom?: number, corner?: unknown, size?: unknown, collapsed?: boolean, margin?: number }} input
 */
export function sessionDockBounds(input) {
  const windowWidth = Math.max(0, Math.round(Number(input?.windowWidth) || 0));
  const windowHeight = Math.max(0, Math.round(Number(input?.windowHeight) || 0));
  const zoom = Number.isFinite(input?.zoom) && Number(input.zoom) > 0 ? Number(input.zoom) : 1;
  const corner = normalizeSessionDockCorner(input?.corner);
  const requestedSize = input?.size === undefined
    ? input?.collapsed === true ? "bubble" : undefined
    : input.size;
  const size = sessionDockSize(requestedSize);
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
 * The session the dock should render. The main renderer owns the truth; the
 * native dock only needs enough to load the route, never transcript content.
 * @param {unknown} value
 */
export function normalizeSessionDockTarget(value) {
  const candidate = value && typeof value === "object" ? value : {};
  const workspaceId = typeof candidate.workspaceId === "string" ? candidate.workspaceId.trim().slice(0, 200) : "";
  const sessionId = typeof candidate.sessionId === "string" ? candidate.sessionId.trim().slice(0, 200) : "";
  return {
    workspaceId,
    sessionId,
    dark: candidate.dark === true,
  };
}

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

/**
 * The dock route is the app itself, so it inherits fonts, theme and components.
 * `size` is only an initial hint; resizing stays in-process so the composer
 * keeps focus.
 * @param {string} baseUrl
 * @param {unknown} target
 * @param {unknown} [size]
 */
export function sessionDockUrl(baseUrl, target, size) {
  const url = new URL(baseUrl);
  const normalized = normalizeSessionDockTarget(target);
  const params = new URLSearchParams();
  if (normalized.workspaceId) params.set("workspace", normalized.workspaceId);
  if (normalized.sessionId) params.set("session", normalized.sessionId);
  if (size !== undefined) params.set("size", normalizeSessionDockSize(size));
  const query = params.toString();
  url.hash = `#/dock${query ? `?${query}` : ""}`;
  return url.toString();
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
 *   getAppUrl: () => string,
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
  getAppUrl,
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
  let target = normalizeSessionDockTarget(null);
  let targetKey = "";
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
      size: layout.size,
    });
  }

  function routeUrl() {
    return sessionDockUrl(getAppUrl(), target, layout.size);
  }

  function keyFor(next) {
    return `${next.workspaceId}\u001f${next.sessionId}`;
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
    targetKey = keyFor(target);
    void view.webContents.loadURL(routeUrl());
    return view;
  }

  function sendLayout() {
    if (!view || !ready || view.webContents.isDestroyed()) return;
    view.webContents.send(SESSION_DOCK_LAYOUT_STATE_CHANNEL, { ...layout });
  }

  function sendTheme() {
    if (!view || !ready || view.webContents.isDestroyed()) return;
    view.webContents.send(SESSION_DOCK_THEME_CHANNEL, { dark: target.dark });
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
    // A floating dock is its own child window: the OS stacks it above the
    // page, which sibling web views inside the window do not guarantee.
    if (!dock.floating) {
      try {
        placeInHost(dock, mainWindow);
      } catch {
        return;
      }
    }
    attached = true;
    if (!visible) {
      dock.setVisible?.(true);
      visible = true;
    }
    updateBounds();
    // The browser area may have moved inside the window without the dock's
    // own bounds changing.
    dock.reposition?.();
    // Inside the window (no browser container yet) the dock still has to beat
    // the other native views to the top.
    if (!dock.floating && parent === mainWindow.contentView) bringToTop(dock);
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

  /** The main renderer publishes the focused session; only a change navigates. */
  function setTarget(next) {
    const normalized = normalizeSessionDockTarget(next);
    const nextKey = keyFor(normalized);
    const sessionChanged = nextKey !== targetKey;
    const darkChanged = normalized.dark !== target.dark;
    target = normalized;
    if (sessionChanged) {
      targetKey = nextKey;
      ready = false;
      if (view && !view.webContents.isDestroyed()) void view.webContents.loadURL(routeUrl());
    }
    if (darkChanged) sendTheme();
    return target;
  }

  function setLayout(next) {
    const merged = normalizeSessionDockLayout({
      corner: next?.corner ?? layout.corner,
      size: next?.size ?? layout.size,
    });
    if (merged.corner === layout.corner && merged.size === layout.size) {
      sendLayout();
      return layout;
    }
    layout = merged;
    persist();
    updateBounds();
    sendLayout();
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
    layout = normalizeSessionDockLayout({ corner, size: layout.size });
    persist();
    updateBounds();
    sendLayout();
    return layout;
  }

  function markReady(sender) {
    if (!view || sender !== view.webContents) return false;
    ready = true;
    sendLayout();
    sendTheme();
    return true;
  }

  function isSender(sender) {
    return Boolean(view && !view.webContents.isDestroyed() && sender === view.webContents);
  }

  function handleAction(channel, payloadValue, sender) {
    if (!isSender(sender)) return false;
    if (channel === SESSION_DOCK_BACK_CHANNEL) {
      sendToRenderer(SESSION_DOCK_BACK_EVENT);
      return true;
    }
    if (channel === SESSION_DOCK_SIDEBAR_CHANNEL) {
      sendToRenderer(SESSION_DOCK_SIDEBAR_EVENT);
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
    if (dock?.floating) {
      dock.close?.();
      return;
    }
    try { dock?.webContents.close(); } catch { /* already destroyed */ }
  }

  return {
    show,
    hide,
    setTarget,
    setLayout,
    dragBy,
    markReady,
    isSender,
    handleAction,
    getLayout: () => ({ ...layout }),
    getTarget: () => ({ ...target }),
    isVisible: () => visible,
    destroy,
  };
}
