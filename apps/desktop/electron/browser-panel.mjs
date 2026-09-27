// Embedded browser panel: tab state, BrowserView lifecycle, menu overlay,
// proxy configuration, and browser IPC registrations. Extracted from
// main.mjs as a factory so the main process only owns window creation.
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { app, WebContentsView, clipboard, dialog, nativeTheme, session, shell } from "electron";

import {
  PEEK_SHIELD_ACTION_CHANNEL,
  PEEK_SHIELD_POINTER_CHANNEL,
  PEEK_SHIELD_READY_CHANNEL,
  PEEK_SHIELD_CHROME_CHANNEL,
  peekPointerReport,
  peekShieldUrl,
} from "./browser-peek-shield.mjs";
import {
  effectiveBrowserViewport,
  browserPeekLayoutZoom,
  browserViewBackground,
  createAgentLeaseRegistry,
  createBrowserTabRuntimeState,
  createViewportController,
  normalizeBrowserViewport,
  normalizeBrowserZoom,
  normalizePanOffset,
  resolvePageZoomFactor,
  transitionPageState,
} from "./browser-tab-state.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BROWSER_SESSION_PARTITION = "persist:sofia-browser";
const BROWSER_DEFAULT_URL = "about:blank";
// URL a user-initiated new tab (the "+" button / opening the browser panel)
// lands on. The agent's programmatic path keeps BROWSER_DEFAULT_URL.
const BROWSER_NEW_TAB_URL = "https://www.google.com";
const BROWSER_TARGET_RESOLVE_TIMEOUT_MS = 2500;
const BROWSER_TARGET_RESOLVE_INTERVAL_MS = 80;
const MENU_OVERLAY_HTML = "overlay.html";
const MENU_OVERLAY_WIDTH = 196;
const MENU_OVERLAY_HEIGHT = 176;
const MENU_OVERLAY_READY_TIMEOUT_MS = 2000;

export function createBrowserPanel({ getWindow, remoteDebugPort, onDeepLink, agentCdpBaseUrl }) {
  const browserTabs = new Map();
  let browserTabOrder = [];
  let activeBrowserTabId = null;
  let browserViewVisible = false;
  // Last browser panel bounds reported by the renderer, in renderer CSS pixels.
  // Converted to window device-independent pixels at every setBounds call.
  let lastBrowserBounds = null;
  let browserTabCounter = 0;
  // Active proxy for the built-in browser session: { rules, username, password }.
  let browserProxy = null;
  let menuOverlayView = null;
  let menuOverlayRequest = null;
  let menuOverlayReady = false;
  let menuOverlayReadyResolvers = [];
  let menuOverlayShowSerial = 0;

  function window() {
    return getWindow?.() ?? null;
  }

  function resetMenuOverlayReady({ resolvePending = false } = {}) {
    menuOverlayReady = false;
    if (resolvePending) {
      const resolvers = menuOverlayReadyResolvers.splice(0);
      for (const resolve of resolvers) resolve(false);
    }
  }

  function markMenuOverlayReady(view) {
    if (!view || view.webContents.isDestroyed()) return;
    menuOverlayReady = true;
    const resolvers = menuOverlayReadyResolvers.splice(0);
    for (const resolve of resolvers) resolve(true);
  }

  function waitForMenuOverlayReady(view) {
    if (menuOverlayReady) return Promise.resolve(true);
    return new Promise((resolve) => {
      let timer = null;
      const done = (ready) => {
        if (timer) clearTimeout(timer);
        menuOverlayReadyResolvers = menuOverlayReadyResolvers.filter((candidate) => candidate !== done);
        resolve(ready);
      };
      timer = setTimeout(() => done(false), MENU_OVERLAY_READY_TIMEOUT_MS);
      menuOverlayReadyResolvers.push(done);
      if (!view || view.webContents.isDestroyed()) done(false);
    });
  }

  /** Send an IPC message to the main renderer, guarding against disposed frames. */
  function sendToRenderer(channel, payload) {
    const mainWindow = window();
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
    try { mainWindow.webContents.send(channel, payload); } catch { /* window closing */ }
  }

  function createBrowserTabId() {
    browserTabCounter += 1;
    return `tab_${Date.now().toString(36)}_${browserTabCounter.toString(36)}`;
  }

  function normalizeBrowserUrl(url, fallback = BROWSER_DEFAULT_URL) {
    const target = typeof url === "string" && url.trim() ? url.trim() : fallback;
    if (!target || target === "about:blank") return "about:blank";
    return /^https?:\/\//i.test(target) ? target : `https://${target}`;
  }

  function isMainWindowAllowedNavigation(url) {
    if (!url) return true;
    if (url.startsWith("file://") || url.startsWith("data:")) return true;
    try {
      const target = new URL(url);
      if (target.hostname === "127.0.0.1" || target.hostname === "localhost" || target.hostname === "[::1]") return true;
      const currentUrl = window()?.webContents.getURL();
      if (!currentUrl || currentUrl === "about:blank") return true;
      const current = new URL(currentUrl);
      return target.origin === current.origin;
    } catch {
      return true;
    }
  }

  function routeBlockedMainWindowNavigation(url) {
    if (!/^https?:\/\//i.test(String(url ?? ""))) return;
    void openBrowserUrlForAutomation(url).catch((error) => {
      console.warn("[browser] failed to route blocked main-window navigation", error);
    });
  }

  function cdpBrowserUrl() {
    // Prefer the CDP broker when it is available so agent-driven Input events
    // are rewritten with human-like cursor motion. Falls back to the raw
    // Chromium CDP endpoint so the panel works without the broker.
    if (agentCdpBaseUrl) return agentCdpBaseUrl;
    return `http://127.0.0.1:${remoteDebugPort}`;
  }

  function browserTargetMarkerUrl(tabId) {
    const marker = `sofia-browser-tab:${tabId}`;
    const html = `<!doctype html><title>${marker}</title><meta name="sofia-browser-tab" content="${tabId}"><body>${marker}</body>`;
    return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
  }

  async function listCdpTargets() {
    if (!remoteDebugPort || remoteDebugPort <= 0) return [];
    // loopback-fetch: CDP discovery targets Electron's local remote debugging port on 127.0.0.1.
    const response = await fetch(`${cdpBrowserUrl()}/json/list`, { signal: AbortSignal.timeout(1000) });
    if (!response.ok) throw new Error(`CDP target list failed: HTTP ${response.status}`);
    const targets = await response.json();
    return Array.isArray(targets) ? targets : [];
  }

  async function resolveBrowserCdpTargetId(tabId) {
    const marker = encodeURIComponent(`sofia-browser-tab:${tabId}`);
    const deadline = Date.now() + BROWSER_TARGET_RESOLVE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const targets = await listCdpTargets().catch(() => []);
      const target = targets.find((candidate) => (
        candidate?.type === "page" &&
        typeof candidate.id === "string" &&
        typeof candidate.url === "string" &&
        candidate.url.includes(marker)
      ));
      if (target?.id) return target.id;
      await new Promise((resolve) => setTimeout(resolve, BROWSER_TARGET_RESOLVE_INTERVAL_MS));
    }
    throw new Error("Could not resolve built-in browser CDP target.");
  }

  async function openBrowserUrlForAutomation(rawUrl, provider = "auto") {
    const requestedProvider = String(provider || "auto").trim().toLowerCase();
    if (requestedProvider && requestedProvider !== "auto" && requestedProvider !== "builtin") {
      throw new Error(`Browser provider is not available yet: ${requestedProvider}`);
    }
    const url = normalizeBrowserUrl(rawUrl);
    const tab = createBrowserTab("about:blank", { select: true });
    await tab.view.webContents.loadURL(browserTargetMarkerUrl(tab.tabId));
    const targetId = await resolveBrowserCdpTargetId(tab.tabId);
    // Kick off the real navigation without awaiting full load — heavy pages
    // (Netflix, dashboards) can take longer than the agent's bridge timeout,
    // which made browser.open_url time out and forced the agent to fall back
    // to new_page (causing tab drift). The target id is what matters; the
    // agent snapshots/wait_for after the page settles.
    void tab.view.webContents.loadURL(url).catch(() => {});
    return {
      provider: "builtin",
      browser_url: cdpBrowserUrl(),
      target_id: targetId,
      tab_id: tab.tabId,
      url,
    };
  }

  // Backing for the broker's Target.createTarget interception: creates a real,
  // visible built-in browser tab (so new_page works on Electron, which cannot
  // create raw CDP targets) and returns its CDP target id.
  /**
   * @param {{ url?: string, background?: boolean, width?: number, height?: number }} [options]
   * @returns {Promise<{ targetId: string, tabId: string, url: string }>}
   */
  async function createTargetForAgent({ url, background = false } = {}) {
    const target = url ? normalizeBrowserUrl(url) : "about:blank";
    const tab = createBrowserTab("about:blank", { select: !background });
    await tab.view.webContents.loadURL(browserTargetMarkerUrl(tab.tabId));
    const targetId = await resolveBrowserCdpTargetId(tab.tabId);
    // Agent control is a lease over the tab the user already owns. Acquiring it
    // here and releasing it later never changes the tab's viewport or zoom.
    agentLeases.acquire(tab.tabId, { cdpSessionId: targetId });
    if (target !== "about:blank") {
      // Fire-and-forget like openBrowserUrlForAutomation so new_page returns
      // fast on heavy pages instead of blocking on full load.
      void tab.view.webContents.loadURL(target).catch(() => {});
    }
    return { targetId, tabId: tab.tabId, url: target };
  }

  function getBrowserTab(tabId = activeBrowserTabId) {
    return tabId ? browserTabs.get(tabId) ?? null : null;
  }

  function getActiveBrowserView() {
    return getBrowserTab()?.view ?? null;
  }

  function getActiveWebContents() {
    return getActiveBrowserView()?.webContents ?? null;
  }

  function getBrowserTabLabel(title, url) {
    if (title) {
      return title;
    }

    if (url && url !== "about:blank") {
      return url;
    }

    return "New tab";
  }

  function browserTabToPanelTab(tabId, tab) {
    const webContents = tab.view.webContents;
    // A failed load leaves Chromium on its own chrome-error:// page, which would
    // blank the address bar. Report the URL the user actually asked for.
    const failedUrl = tab.state.pageState.status === "error" ? tab.state.pageState.error?.url : null;
    const url = failedUrl && failedUrl !== "about:blank" ? failedUrl : webContents.getURL();
    const title = webContents.getTitle();

    return {
      id: tabId,
      type: "browser",
      label: getBrowserTabLabel(title, url),
      url,
      favicon: tab.favicon ?? null,
      canGoBack: webContents.navigationHistory.canGoBack(),
      canGoForward: webContents.navigationHistory.canGoForward(),
      // Page health and agent health are reported separately: a page the user
      // can still read must never be described as a browser failure.
      pageState: tab.state.pageState,
      agentState: agentLeases.statusFor(tabId),
      appliedViewport: tab.state.appliedViewport,
      appliedBounds: tab.state.appliedBounds,
    };
  }

  function listBrowserTabs() {
    return browserTabOrder
      .map((tabId) => {
        const tab = browserTabs.get(tabId);
        if (!tab || tab.view.webContents.isDestroyed()) return null;
        return browserTabToPanelTab(tabId, tab);
      })
      .filter(Boolean);
  }

  function browserStatePayload() {
    return {
      activeTabId: activeBrowserTabId,
      tabs: listBrowserTabs(),
    };
  }

  function browserTabUrl(tab) {
    const url = tab?.view?.webContents?.getURL?.();
    return typeof url === "string" && url && url !== "about:blank" ? url : null;
  }

  function isHttpUrl(url) {
    try {
      const parsed = new URL(url);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  }

  function normalizeMenuOverlayPoint(point) {
    if (!point || typeof point !== "object") {
      return { x: 0, y: 0 };
    }
    const x = Number(point.x);
    const y = Number(point.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return { x: 0, y: 0 };
    }
    return { x: Math.round(x), y: Math.round(y) };
  }

  function menuOverlayBounds(point, width = MENU_OVERLAY_WIDTH, height = MENU_OVERLAY_HEIGHT) {
    const [contentWidth, contentHeight] = window()?.getContentSize?.() ?? [MENU_OVERLAY_WIDTH, MENU_OVERLAY_HEIGHT];
    return {
      x: Math.min(Math.max(point.x, 0), Math.max(contentWidth - width - 4, 0)),
      y: Math.min(Math.max(point.y, 0), Math.max(contentHeight - height - 4, 0)),
      width: Math.min(width, contentWidth),
      height: Math.min(height, contentHeight),
    };
  }

  function menuOverlayUrl() {
    const currentUrl = window()?.webContents?.getURL?.();
    if (currentUrl && /^https?:\/\//i.test(currentUrl)) {
      return new URL(MENU_OVERLAY_HTML, currentUrl).toString();
    }
    return null;
  }

  async function loadMenuOverlayRenderer(view) {
    const devUrl = menuOverlayUrl();
    if (devUrl) {
      await view.webContents.loadURL(devUrl);
      return;
    }

    const packagedOverlayPath = path.join(process.resourcesPath, "app-dist", MENU_OVERLAY_HTML);
    const devOverlayPath = path.resolve(__dirname, "../../app/dist", MENU_OVERLAY_HTML);
    await view.webContents.loadFile(app.isPackaged ? packagedOverlayPath : devOverlayPath);
  }

  async function ensureMenuOverlayView() {
    if (menuOverlayView && !menuOverlayView.webContents.isDestroyed()) {
      return menuOverlayView;
    }

    const view = new WebContentsView({
      webPreferences: {
        // Electron only runs ESM preload scripts reliably with sandbox disabled.
        // Keep the bridge isolated and node-free for the React overlay document.
        backgroundThrottling: false,
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false,
        preload: path.join(__dirname, "menu-overlay-preload.mjs"),
      },
    });
    view.setBackgroundColor?.("#00000000");
    view.setVisible?.(false);
    view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    view.webContents.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) resetMenuOverlayReady();
    });
    view.webContents.once("destroyed", () => {
      if (menuOverlayView === view) {
        menuOverlayView = null;
        menuOverlayRequest = null;
        resetMenuOverlayReady({ resolvePending: true });
      }
    });

    menuOverlayView = view;
    resetMenuOverlayReady({ resolvePending: true });
    await loadMenuOverlayRenderer(view);
    return view;
  }

  function hideMenuOverlay() {
    const view = menuOverlayView;
    const mainWindow = window();
    menuOverlayShowSerial += 1;
    menuOverlayRequest = null;
    if (!view || !mainWindow) return;
    view.setVisible?.(false);
    try {
      if (mainWindow.contentView.children.includes(view)) {
        mainWindow.contentView.removeChildView(view);
      }
    } catch {
      // already removed
    }
  }

  function bringMenuOverlayToTop(view) {
    bringNativeViewToTop(view);
  }

  function bringNativeViewToTop(view) {
    const mainWindow = window();
    if (!mainWindow) return;
    try {
      if (mainWindow.contentView.children.includes(view)) {
        mainWindow.contentView.removeChildView(view);
      }
    } catch {
      // already removed
    }
    mainWindow.contentView.addChildView(view);
  }

  function tabMenuRequest(tab, point) {
    const url = browserTabUrl(tab);
    return {
      id: `tab-menu:${tab.tabId}:${Date.now()}`,
      source: "tab",
      tabId: tab.tabId,
      url,
      bounds: menuOverlayBounds(normalizeMenuOverlayPoint(point)),
      items: [
        { id: "copy-url", label: "Copy URL", iconName: "copy", disabled: !url },
        { id: "open-external", label: "Open in Browser", iconName: "external", disabled: !(url && isHttpUrl(url)) },
        { id: "close-tab", label: "Close Tab", iconName: "close", separatorBefore: true },
        { id: "close-all-tabs", label: "Close All Tabs", iconName: "close" },
      ],
    };
  }

  async function showBrowserTabContextMenu(tabId, point) {
    const tab = getBrowserTab(String(tabId ?? ""));
    if (!window() || !tab || tab.view.webContents.isDestroyed()) return;

    return showMenuOverlay(tabMenuRequest(tab, point ? scaleRendererPoint(point) : point));
  }

  async function showBrowserToolbarMenu(tabId, kind, point) {
    const tab = requireBrowserTab(tabId);
    if (!["browser", "viewport", "zoom"].includes(kind)) throw new Error("Unknown browser menu");
    return showMenuOverlay({
      id: `browser-menu:${tab.tabId}:${Date.now()}`,
      source: kind,
      tabId: tab.tabId,
      url: browserTabUrl(tab),
      bounds: menuOverlayBounds(scaleRendererPoint(point), 300, kind === "viewport" ? 410 : kind === "zoom" ? 400 : 390),
      viewport: tab.state.viewport,
      zoom: tab.state.zoom,
      appliedScale: tab.state.appliedViewport?.scale ?? null,
      items: [
        { id: "find", label: "Find in page", shortcut: "⌘F" },
        { id: "print", label: "Print…" },
        { id: "zoom", label: "Zoom", separatorBefore: true },
        { id: "viewport", label: "Show device toolbar" },
        { id: "screenshot", label: "Take a screenshot" },
        { id: "copy-url", label: "Copy URL", disabled: !browserTabUrl(tab), separatorBefore: true },
        { id: "open-external", label: "Open in default browser", disabled: !browserTabUrl(tab) },
        { id: "peek", label: "Show in peek", separatorBefore: true },
        { id: "docked", label: "Dock beside conversation" },
        { id: "expanded", label: "Expand browser" },
      ],
    });
  }

  async function showMenuOverlay(request) {
    const showSerial = ++menuOverlayShowSerial;
    const view = await ensureMenuOverlayView();
    if (showSerial !== menuOverlayShowSerial || menuOverlayView !== view) return;
    menuOverlayRequest = request;
    view.setBounds(request.bounds);
    view.setVisible?.(true);
    bringMenuOverlayToTop(view);
    const ready = await waitForMenuOverlayReady(view);
    if (showSerial !== menuOverlayShowSerial || menuOverlayRequest !== request || menuOverlayView !== view) return;
    if (!ready) {
      console.warn("[menu-overlay] renderer did not signal readiness before show");
    }
    view.webContents.send("sofia:menu-overlay:show", {
      id: request.id,
      source: request.source,
      items: request.items,
      viewport: request.viewport,
      zoom: request.zoom,
      appliedScale: request.appliedScale,
    });
    view.webContents.focus();
  }

  async function handleMenuOverlayChoice(payload) {
    if (!payload || payload.requestId !== menuOverlayRequest?.id) return;
    const request = menuOverlayRequest;
    const tab = getBrowserTab(request.tabId);
    hideMenuOverlay();

    switch (payload.itemId) {
      case "set-viewport":
        if (tab) {
          setBrowserTabViewport(tab.tabId, payload.value);
          sendToRenderer("sofia:browser:controls-changed", { tabId: tab.tabId, viewport: tab.state.viewport, zoom: tab.state.zoom });
        }
        break;
      case "set-zoom":
        if (tab) {
          setBrowserTabZoom(tab.tabId, payload.value);
          sendToRenderer("sofia:browser:controls-changed", { tabId: tab.tabId, viewport: tab.state.viewport, zoom: tab.state.zoom });
        }
        break;
      case "viewport":
      case "zoom":
        if (tab) await showBrowserToolbarMenu(tab.tabId, payload.itemId, { x: request.bounds.x / mainWindowZoomFactor(), y: request.bounds.y / mainWindowZoomFactor() });
        break;
      case "find":
        sendToRenderer("sofia:browser:find-requested", { tabId: request.tabId });
        break;
      case "print":
        tab?.view.webContents.print();
        break;
      case "screenshot": {
        if (!tab) break;
        const capture = await tab.view.webContents.capturePage();
        const result = await dialog.showSaveDialog(window(), { defaultPath: "browser-screenshot.png", filters: [{ name: "PNG image", extensions: ["png"] }] });
        if (!result.canceled && result.filePath) await writeFile(result.filePath, capture.toPNG());
        break;
      }
      case "peek":
      case "docked":
      case "expanded":
        sendToRenderer("sofia:browser:presentation-requested", payload.itemId);
        break;
      case "copy-url":
        if (request.url) clipboard.writeText(request.url);
        break;
      case "open-external":
        if (request.url && isHttpUrl(request.url)) void shell.openExternal(request.url);
        break;
      case "close-tab":
        if (tab) closeBrowserTab(tab.tabId);
        break;
      case "close-all-tabs":
        closeAllBrowserTabs();
        break;
    }
  }

  function resolveBrowserProxyInput(input) {
    const raw = String(input ?? "").trim();
    const envMatch = raw.match(/^env:([A-Za-z0-9_]+)$/i);
    if (!envMatch) return raw;
    const key = `SOFIA_BROWSER_PROXY_${envMatch[1].toUpperCase()}`;
    const value = String(process.env[key] ?? "").trim();
    if (!value) throw new Error(`No proxy configured: set the ${key} environment variable to a proxy URL.`);
    return value;
  }

  function parseBrowserProxyInput(input) {
    const raw = resolveBrowserProxyInput(input);
    if (!raw) return null;
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
    let url;
    try {
      url = new URL(withScheme);
    } catch {
      throw new Error(`Invalid proxy URL: ${raw}`);
    }
    if (!url.hostname || !url.port) {
      throw new Error("Proxy must include host and port, e.g. http://user:pass@host:8080 or socks5://host:1080.");
    }
    const scheme = url.protocol.replace(/:$/, "").toLowerCase();
    return {
      rules: `${scheme}://${url.hostname}:${url.port}`,
      username: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
    };
  }

  function browserProxyState() {
    return {
      proxy: browserProxy
        ? { rules: browserProxy.rules, authenticated: Boolean(browserProxy.username) }
        : null,
    };
  }

  async function setBrowserProxy(proxyInput) {
    const browserSession = session.fromPartition(BROWSER_SESSION_PARTITION);
    const parsed = parseBrowserProxyInput(proxyInput);
    if (parsed) {
      await browserSession.setProxy({ proxyRules: parsed.rules, proxyBypassRules: "<local>" });
    } else {
      await browserSession.setProxy({ mode: "system" });
    }
    browserProxy = parsed;
    // Drop keep-alive connections so existing tabs cannot bypass the new proxy.
    await browserSession.closeAllConnections();
    return browserProxyState();
  }

  app.on("login", (event, _webContents, _details, authInfo, callback) => {
    if (!authInfo?.isProxy || !browserProxy?.username) return;
    event.preventDefault();
    callback(browserProxy.username, browserProxy.password);
  });

  function createBrowserTab(url = "about:blank", { select = true } = {}) {
    const tabId = createBrowserTabId();
    const view = new WebContentsView({
      webPreferences: {
        backgroundThrottling: false,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        preload: path.join(__dirname, "browser-content-preload.cjs"),
        partition: BROWSER_SESSION_PARTITION,
      },
    });
    // `state` is the durable, user-owned part of the tab (viewport, zoom, page
    // and agent health). Agent leases are layered on top, never stored here.
    const tab = { tabId, view, favicon: null, state: createBrowserTabRuntimeState(tabId) };
    browserTabs.set(tabId, tab);
    browserTabOrder.push(tabId);
    // Load about:blank immediately to preempt persistent-session restore.
    // Cookies live on the session object, not the document — they survive this.
    view.webContents.loadURL("about:blank");
    view.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
      void shell.openExternal(targetUrl);
      return { action: "deny" };
    });
    view.webContents.on("did-start-navigation", (_event, targetUrl, isInPlace, isMainFrame) => {
      if (!isMainFrame || isInPlace) return;
      const target = String(targetUrl ?? "");
      // data: loads are internal plumbing (CDP target-marker pages), not
      // user-visible navigations — don't surface the panel for them.
      if (target === "about:blank" || target.startsWith("data:")) return;
      // Intercept sofia:// deep links (e.g. den-auth handoff grants) so
      // in-app browser auth works without the system protocol handler.
      if (target.startsWith("sofia://") || target.startsWith("sofia-dev://")) {
        if (typeof onDeepLink === "function") {
          onDeepLink([target]);
        }
        // Navigate the tab to about:blank to prevent the custom-scheme load
        // from erroring, then hide the panel. Avoid closing the tab
        // synchronously during a navigation event to prevent renderer crashes.
        setTimeout(() => {
          try {
            if (!view.webContents.isDestroyed()) {
              view.webContents.loadURL("about:blank");
            }
            hideBrowserView();
          } catch { /* tab already gone */ }
        }, 200);
        return;
      }
      // Agent-driven CDP navigation can target a background tab whose view is
      // detached. Bring that tab on screen, otherwise navigation "succeeds"
      // while the visible tab stays on about:blank (#2015).
      if (activeBrowserTabId !== tabId) {
        try {
          selectBrowserTab(tabId);
        } catch {
          // The tab may be mid-close; the fact below is still reported.
        }
      }
      // A fact, not a product decision: a real page is now on screen in a tab.
      // Whether the user sees a peek, a docked panel or nothing is renderer
      // presentation policy.
      sendToRenderer("sofia:browser:tab-activated", { tabId });
    });
    view.webContents.on("did-navigate", () => {
      // Navigations can drop the renderer's metrics override; re-assert the
      // tab's own viewport. Detaching an agent never does this.
      if (tab.state.viewport.mode === "responsive") {
        void applyTabViewport(tabId, { force: true });
      }
      sendBrowserState();
    });
    view.webContents.on("did-navigate-in-page", () => sendBrowserState());
    view.webContents.on("page-title-updated", () => sendBrowserState());
    view.webContents.on("page-favicon-updated", (_event, favicons) => {
      tab.favicon = Array.isArray(favicons) ? favicons[0] ?? null : null;
      sendBrowserState();
    });
    view.webContents.on("did-start-loading", () => {
      tab.state.pageState = transitionPageState(tab.state.pageState, "start");
      sendBrowserState();
    });
    view.webContents.on("did-stop-loading", () => {
      tab.state.pageState = transitionPageState(tab.state.pageState, "stop");
      sendBrowserState();
    });
    view.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      // ERR_ABORTED (-3) is a superseded navigation, not a broken page.
      if (!isMainFrame || errorCode === -3) return;
      tab.state.pageState = transitionPageState(tab.state.pageState, "fail", {
        code: errorCode,
        description: String(errorDescription ?? ""),
        url: String(validatedURL ?? ""),
      });
      sendBrowserState();
    });
    view.webContents.once("destroyed", () => {
      agentLeases.releaseTab(tabId);
      viewportController.forget(tabId);
      browserTabs.delete(tabId);
      browserTabOrder = browserTabOrder.filter((id) => id !== tabId);
      if (activeBrowserTabId === tabId) activeBrowserTabId = browserTabOrder[0] ?? null;
      sendBrowserState();
    });
    if (select || !activeBrowserTabId) {
      selectBrowserTab(tabId);
    } else {
      sendBrowserState();
    }
    const finalUrl = normalizeBrowserUrl(url, "about:blank");
    if (finalUrl !== "about:blank") {
      view.webContents.loadURL(finalUrl);
    }
    return tab;
  }

  function detachBrowserView(view) {
    const mainWindow = window();
    if (!mainWindow || !view) return;
    try {
      if (mainWindow.contentView.children.includes(view)) {
        mainWindow.contentView.removeChildView(view);
      }
    } catch {
      // already removed
    }
  }

  // The renderer reports bounds in CSS pixels, which Electron scales by the main
  // window's zoom factor. Read the factor from the webContents at apply time so
  // the conversion is always correct, no matter how the zoom was changed
  // (shortcuts, native menu, or Chromium's persisted per-origin zoom).
  function mainWindowZoomFactor() {
    try {
      const factor = window()?.webContents.getZoomFactor();
      return typeof factor === "number" && factor > 0 ? factor : 1;
    } catch {
      return 1;
    }
  }

  function scaleRendererBounds(bounds) {
    const zoom = mainWindowZoomFactor();
    // Round edges (not width/height) so the far edge has no sub-pixel seam.
    const x = Math.round(bounds.x * zoom);
    const y = Math.round(bounds.y * zoom);
    return {
      x,
      y,
      width: Math.round((bounds.x + bounds.width) * zoom) - x,
      height: Math.round((bounds.y + bounds.height) * zoom) - y,
    };
  }

  function scaleRendererPoint(point) {
    const zoom = mainWindowZoomFactor();
    return { x: Math.round(point.x * zoom), y: Math.round(point.y * zoom) };
  }

  // Agent control is a temporary lease over a user-owned tab. Leases live here
  // (never in the persisted renderer store) and reach the page only through CDP
  // emulation, which is derived from tab state alone.
  const agentLeases = createAgentLeaseRegistry();

  async function sendTabCdpCommand(tabId, method, params) {
    const tab = getBrowserTab(tabId);
    if (!tab || tab.view.webContents.isDestroyed()) return undefined;
    const debuggerApi = tab.view.webContents.debugger;
    try {
      if (!debuggerApi.isAttached()) debuggerApi.attach("1.3");
      // `sendCommand` reports its failures by rejecting, so the await has to be
      // inside the try: a target that closes while a command is in flight
      // rejects with "target closed while handling command", and returning the
      // bare promise let that rejection escape this catch and fail the whole
      // viewport apply instead.
      return await debuggerApi.sendCommand(method, params ?? {});
    } catch (error) {
      // A DevTools or agent CDP client can already hold this target. Emulation
      // is best effort: losing it must never break navigation or agent control.
      console.warn(`[browser] could not apply ${method}`, error);
      return undefined;
    }
  }

  const viewportController = createViewportController({
    sendCommand: sendTabCdpCommand,
    release: releaseTabDebugger,
    setBounds: (tabId, bounds) => {
      if (!bounds) return;
      const tab = getBrowserTab(tabId);
      if (tab && !tab.view.webContents.isDestroyed()) tab.view.setBounds(bounds);
    },
  });

  /**
   * We hold the page debugger only for as long as a virtual viewport needs it,
   * so the agent's CDP client gets the target back as soon as emulation ends.
   */
  function releaseTabDebugger(tabId) {
    const tab = getBrowserTab(tabId);
    if (!tab || tab.view.webContents.isDestroyed()) return;
    try {
      if (tab.view.webContents.debugger.isAttached()) tab.view.webContents.debugger.detach();
    } catch {
      // Already detached, or the view is closing.
    }
  }

  /**
   * The only place a browser view's bounds and page viewport are decided.
   * Panel resizes only ever change the fit scale; the virtual viewport is
   * tab state and is never rewritten here.
   */
  // Monotonic so a slow apply can never report a stale scale: a panel drag
  // issues roughly one apply per frame.
  let viewportApplySerial = 0;

  /**
   * The letterbox around a responsive device frame is painted with the native
   * view's background, so it must track both the viewport mode and the app
   * theme — a white default made the frame's cutout read as part of the page.
   */
  function applyBrowserViewBackground(tab, responsive) {
    if (!tab || tab.view.webContents.isDestroyed()) return;
    tab.view.setBackgroundColor?.(
      browserViewBackground({ responsive, dark: nativeTheme.shouldUseDarkColors }),
    );
  }

  /**
   * How the browser surface is presented to the user. Presentation is policy,
   * not browser state: it never rewrites a tab's durable viewport, and it never
   * touches agent leases. `peek` additionally swaps in a desktop viewport so a
   * small floating card cannot make the page render as a phone.
   */
  /** @type {"hidden" | "peek" | "docked" | "expanded"} */
  let browserPresentation = "docked";

  /**
   * @param {unknown} mode
   * @returns {"hidden" | "peek" | "docked" | "expanded"}
   */
  function normalizeBrowserPresentation(mode) {
    return mode === "hidden" || mode === "peek" || mode === "expanded" ? mode : "docked";
  }

  function setBrowserPresentation(mode) {
    const next = normalizeBrowserPresentation(mode);
    if (next === browserPresentation) return next;
    browserPresentation = next;
    if (next === "hidden") {
      // Hiding is a presentation change: tabs, page and agent all keep running.
      hideBrowserView();
      sendBrowserState();
      return next;
    }
    // Bounds arrive from whichever host the renderer mounted (peek card or
    // docked panel), so only the effective viewport needs a fresh apply.
    if (browserViewVisible) void applyTabViewport(activeBrowserTabId, { force: true });
    return next;
  }

  nativeTheme.on?.("updated", () => {
    for (const tab of browserTabs.values()) {
      if (tab.state.viewport.mode === "responsive") applyBrowserViewBackground(tab, true);
    }
  });

  /**
   * Peek shield.
   *
   * The shield is the transparent native layer that sits directly above the
   * live page (see `browser-peek-shield.mjs`): it is the only layer that can
   * take a human click on a native page, paint above it, and mask its square
   * corners. Human intent to activate, hide or drag the card arrives from it
   * and is forwarded as a fact — presentation policy decides what it means.
   */
  let peekShieldView = null;
  let peekShieldReady = false;
  // Last chrome descriptor the renderer published for the card. Replayed on
  // every shield (re)load, because the shield is disposable and the card is not.
  let peekShieldChrome = null;

  function ensurePeekShieldView() {
    if (peekShieldView && !peekShieldView.webContents.isDestroyed()) return peekShieldView;
    const view = new WebContentsView({
      webPreferences: {
        backgroundThrottling: false,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        preload: path.join(__dirname, "peek-shield-preload.cjs"),
      },
    });
    view.setBackgroundColor?.("#00000000");
    view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    view.webContents.once("destroyed", () => {
      if (peekShieldView === view) {
        peekShieldView = null;
        peekShieldReady = false;
      }
    });
    peekShieldReady = false;
    void view.webContents.loadURL(peekShieldUrl());
    peekShieldView = view;
    return view;
  }

  function sendPeekShieldChrome() {
    const view = peekShieldView;
    if (!view || !peekShieldReady || view.webContents.isDestroyed()) return;
    view.webContents.send(PEEK_SHIELD_CHROME_CHANNEL, peekShieldChrome ?? {});
  }

  /**
   * The card's hover chrome is drawn by the shield, so its content has to come
   * from the renderer that owns the tab state.
   */
  function setPeekShieldChrome(chrome) {
    peekShieldChrome = chrome && typeof chrome === "object" ? chrome : null;
    sendPeekShieldChrome();
    return true;
  }

  function handlePeekShieldPointer(payload) {
    sendToRenderer("sofia:browser:peek-pointer", peekPointerReport(payload, mainWindowZoomFactor()));
  }

  function handlePeekShieldAction(action) {
    if (action === "hide") sendToRenderer("sofia:browser:peek-hidden");
    else if (action === "expand") sendToRenderer("sofia:browser:peek-activated");
  }

  /** Track the Peek page slot with the page itself, so the shield always covers it. */
  function syncPeekShield(bounds) {
    const shouldShow =
      browserPresentation === "peek" &&
      browserViewVisible &&
      Boolean(bounds) &&
      bounds.width > 0 &&
      bounds.height > 0;
    if (!shouldShow) {
      detachPeekShield();
      return;
    }
    const mainWindow = window();
    if (!mainWindow) return;
    const view = ensurePeekShieldView();
    if (!browserTabs.size) {
      detachPeekShield();
      return;
    }
    view.setBounds(bounds);
    bringNativeViewToTop(view);
  }

  function detachPeekShield() {
    if (!peekShieldView) return;
    detachBrowserView(peekShieldView);
  }

  function destroyPeekShield() {
    const view = peekShieldView;
    peekShieldView = null;
    peekShieldReady = false;
    if (!view) return;
    detachBrowserView(view);
    try { view.webContents.close(); } catch { /* already destroyed */ }
  }

  function applyTabViewport(tabId, { force = false } = {}) {
    const tab = getBrowserTab(tabId);
    if (!tab) return undefined;
    const panelBounds = lastBrowserBounds ? scaleRendererBounds(lastBrowserBounds) : null;

    // A collapsed panel is not a place to render a page. Detaching is the only
    // safe answer: a native view keeps its last rectangle, so shrinking the DOM
    // without detaching leaves a page painting over the rest of the app.
    if (isDegeneratePanelBounds(panelBounds)) {
      detachBrowserView(tab.view);
      tab.state.appliedBounds = null;
      return undefined;
    }

    // Presentation-derived: a Peek of a `panel` tab renders desktop while
    // `tab.state.viewport` and `tab.state.zoom` stay exactly what the user
    // chose. Peek keeps that breakpoint through page *zoom*, never through
    // device emulation: emulation gives the page a screen of its own, and the
    // native view paints that screen wherever it lands, so a card smaller than
    // the emulated screen lets the page spill over the whole app. Zoom lays the
    // same page out at the same breakpoint inside the card's own bounds.
    const peekZoom =
      browserPresentation === "peek" && tab.state.viewport?.mode !== "responsive"
        ? { mode: "custom", scale: browserPeekLayoutZoom(panelBounds) }
        : null;

    try {
      tab.view.webContents.setZoomFactor(
        resolvePageZoomFactor(peekZoom ?? tab.state.zoom, peekZoom ? { mode: "panel" } : tab.state.viewport),
      );
    } catch {
      // View already closing; the plan below will bail out the same way.
    }
    viewportApplySerial += 1;
    const serial = viewportApplySerial;
    return viewportController
      .apply({
        tabId,
        viewport: peekZoom
          ? { mode: "panel" }
          : effectiveBrowserViewport(tab.state.viewport, browserPresentation),
        zoom: peekZoom ?? (browserPresentation === "peek" ? { mode: "fit" } : tab.state.zoom),
        panelBounds,
        pan: browserPresentation === "peek" ? { x: 0, y: 0 } : tab.state.pan,
        force,
      })
      .then((plan) => {
        if (serial !== viewportApplySerial || !browserTabs.has(tabId)) return plan;
        applyBrowserViewBackground(tab, Boolean(plan?.emulation));
        if (tabId === activeBrowserTabId) syncPeekShield(plan?.bounds ?? null);
        // The scale is rounded to a tenth of a percent: enough for the toolbar
        // readout, and it keeps a resize drag from reporting every frame.
        const scale = plan?.emulation?.scale;
        const appliedViewport = typeof scale === "number"
          ? {
              scale: Math.round(scale * 1000) / 1000,
              pan: plan.pan,
              overflow: plan.overflow,
            }
          : null;
        const appliedBounds = plan?.bounds ?? null;
        const unchanged = JSON.stringify(tab.state.appliedViewport) === JSON.stringify(appliedViewport) &&
          JSON.stringify(tab.state.appliedBounds) === JSON.stringify(appliedBounds);
        if (unchanged) return plan;
        tab.state.appliedViewport = appliedViewport;
        tab.state.appliedBounds = appliedBounds;
        // The requested pan may have been clamped to the real overflow.
        if (browserPresentation !== "peek") tab.state.pan = plan.pan;
        sendBrowserState();
        return plan;
      })
      .catch((error) => {
        console.warn("[browser] could not apply tab viewport", error);
      });
  }

  const BROWSER_MIN_VISIBLE_CANVAS_PX = 48;

  /** True when the reported canvas is too small to host a page at all. */
  function isDegeneratePanelBounds(bounds) {
    if (!bounds) return false;
    return bounds.width < BROWSER_MIN_VISIBLE_CANVAS_PX || bounds.height < BROWSER_MIN_VISIBLE_CANVAS_PX;
  }

  function attachActiveBrowserView() {
    const mainWindow = window();
    if (!mainWindow || !browserViewVisible) return;
    const view = getActiveBrowserView();
    if (!view) return;
    for (const tab of browserTabs.values()) {
      if (tab.view !== view) detachBrowserView(tab.view);
    }
    if (!mainWindow.contentView.children.includes(view)) {
      // Size and emulate before the view becomes visible, so a responsive tab
      // never flashes at panel width on the way in.
      if (lastBrowserBounds && lastBrowserBounds.width > 0 && lastBrowserBounds.height > 0) {
        void applyTabViewport(activeBrowserTabId, { force: true });
      }
      mainWindow.contentView.addChildView(view);
    }
  }

  function selectBrowserTab(tabId) {
    if (!browserTabs.has(tabId)) throw new Error(`Unknown browser tab: ${tabId}`);
    hideMenuOverlay();
    const previousView = getActiveBrowserView();
    activeBrowserTabId = tabId;
    if (previousView && previousView !== getActiveBrowserView()) {
      detachBrowserView(previousView);
    }
    attachActiveBrowserView();
    sendBrowserState();
    return getBrowserTab(tabId);
  }

  function closeBrowserTab(tabId = activeBrowserTabId) {
    const tab = getBrowserTab(tabId);
    if (!tab) return null;
    if (menuOverlayRequest?.tabId === tabId) hideMenuOverlay();
    const closingIndex = browserTabOrder.indexOf(tabId);
    const wasActive = activeBrowserTabId === tabId;
    detachBrowserView(tab.view);
    browserTabs.delete(tabId);
    browserTabOrder = browserTabOrder.filter((id) => id !== tabId);
    if (wasActive) {
      const nextTabId =
        browserTabOrder[Math.min(closingIndex, browserTabOrder.length - 1)] ??
        browserTabOrder[closingIndex - 1] ??
        null;
      activeBrowserTabId = nextTabId;
      if (nextTabId) {
        attachActiveBrowserView();
      } else {
        hideBrowserView();
        sendToRenderer("sofia:browser:tabs-closed");
      }
    }
    try { tab.view.webContents.close(); } catch { /* already destroyed */ }
    sendBrowserState();
    return tabId;
  }

  function closeAllBrowserTabs() {
    const closedTabIds = [...browserTabOrder];
    if (closedTabIds.length === 0) return [];
    hideMenuOverlay();
    const tabsToClose = closedTabIds
      .map((tabId) => browserTabs.get(tabId))
      .filter(Boolean);
    hideBrowserView();
    browserTabs.clear();
    browserTabOrder = [];
    activeBrowserTabId = null;
    for (const tab of tabsToClose) {
      try { tab.view.webContents.close(); } catch { /* already destroyed */ }
    }
    sendToRenderer("sofia:browser:tabs-closed");
    sendBrowserState();
    return closedTabIds;
  }

  function reorderBrowserTabs(tabIds) {
    const nextOrder = Array.isArray(tabIds) ? tabIds.map(String) : [];
    if (nextOrder.length !== browserTabOrder.length) {
      throw new Error("Tab order must include every open tab.");
    }
    if (new Set(nextOrder).size !== nextOrder.length) {
      throw new Error("Tab order must not contain duplicate tabs.");
    }
    const current = new Set(browserTabOrder);
    if (nextOrder.some((tabId) => !current.has(tabId))) {
      throw new Error("Tab order contains an unknown tab.");
    }
    browserTabOrder = nextOrder;
    sendBrowserState();
    return listBrowserTabs();
  }

  function sendBrowserState() {
    sendToRenderer("sofia:browser:state", browserStatePayload());
  }

  /**
   * Attach the browser view to the main window.
   * @param {object} bounds — { x, y, width, height }
   * @param {object} [opts]
   * @param {boolean} [opts.preloadDefault=false] - load default URL if the view has no URL
   * @param {boolean} [opts.ensureTab=false] - create a blank tab if needed
   */
  function attachBrowserView(bounds, { preloadDefault = false, ensureTab = false } = {}) {
    if (!window() || browserPresentation === "hidden") return;
    lastBrowserBounds = bounds;
    browserViewVisible = true;
    if (ensureTab && !activeBrowserTabId) createBrowserTab("about:blank");
    const view = getActiveBrowserView();
    attachActiveBrowserView();
    if (bounds.width > 0 && bounds.height > 0) {
      void applyTabViewport(activeBrowserTabId, { force: true });
    }
    const url = view?.webContents.getURL();
    if (preloadDefault && (!url || url === "about:blank")) {
      view?.webContents.loadURL(BROWSER_DEFAULT_URL);
    }
    sendBrowserState();
  }

  function hideBrowserView() {
    hideMenuOverlay();
    detachPeekShield();
    browserViewVisible = false;
    // Hiding the panel is not a viewport change: emulation and tab state stay.
    if (!window()) return;
    for (const tab of browserTabs.values()) {
      detachBrowserView(tab.view);
    }
  }

  function destroyBrowserView() {
    hideBrowserView();
    destroyPeekShield();
    const overlayView = menuOverlayView;
    menuOverlayView = null;
    menuOverlayRequest = null;
    try { overlayView?.webContents.close(); } catch { /* already destroyed */ }
    for (const tab of browserTabs.values()) {
      agentLeases.releaseTab(tab.tabId);
      viewportController.forget(tab.tabId);
      try { tab.view.webContents.close(); } catch { /* already destroyed */ }
    }
    browserTabs.clear();
    browserTabOrder = [];
    activeBrowserTabId = null;
    lastBrowserBounds = null;
    sendBrowserState();
  }

  function resolveBrowserTabId(tabId) {
    return typeof tabId === "string" && tabId ? tabId : activeBrowserTabId;
  }

  function requireBrowserTab(tabId) {
    const tab = getBrowserTab(resolveBrowserTabId(tabId));
    if (!tab) throw new Error(`Unknown browser tab: ${tabId ?? "(active)"}`);
    return tab;
  }

  // Panel bounds, page viewport, and zoom are three separate intents, so they
  // stay three separate entry points. Nothing may combine them into one resize.
  function setBrowserTabViewport(tabId, viewport) {
    const tab = requireBrowserTab(tabId);
    tab.state.viewport = normalizeBrowserViewport(viewport);
    void applyTabViewport(tab.tabId, { force: true });
    sendBrowserState();
    return tab.state.viewport;
  }

  function setBrowserTabZoom(tabId, zoom) {
    const tab = requireBrowserTab(tabId);
    tab.state.zoom = normalizeBrowserZoom(zoom);
    void applyTabViewport(tab.tabId, { force: true });
    sendBrowserState();
    return tab.state.zoom;
  }

  /**
   * Scroll an overflowing virtual viewport. This moves the emulated frame
   * inside a fixed-size native view; it never resizes the view or the page.
   */
  function setBrowserTabPan(tabId, pan) {
    const tab = requireBrowserTab(tabId);
    tab.state.pan = normalizePanOffset(pan);
    void applyTabViewport(tab.tabId, { force: true });
    sendBrowserState();
    return tab.state.pan;
  }

  /**
   * Agent control lease transitions. Deliberately cannot read or write viewport,
   * zoom, or any other durable tab state.
   */
  function updateAgentLease(action, payload) {
    const tabId = resolveBrowserTabId(payload?.tabId);
    const leaseId = typeof payload?.leaseId === "string" && payload.leaseId ? payload.leaseId : null;

    switch (action) {
      case "acquire": {
        if (!tabId) throw new Error("Cannot acquire a browser lease without a tab");
        agentLeases.acquire(tabId, {
          capabilities: payload?.capabilities,
          cdpSessionId: payload?.cdpSessionId,
        });
        break;
      }
      case "release":
        if (leaseId) agentLeases.release(leaseId);
        else if (tabId) agentLeases.releaseTab(tabId);
        break;
      case "pause":
        agentLeases.pause(leaseId);
        break;
      case "resume":
        agentLeases.resume(leaseId);
        break;
      case "fail":
        agentLeases.fail(leaseId, payload?.error);
        break;
      default:
        throw new Error(`Unknown browser lease action: ${action}`);
    }

    sendBrowserState();
    return tabId ? agentLeases.statusFor(tabId) : { status: "detached" };
  }

  function registerIpc(ipcMain) {
    ipcMain.handle("sofia:browser:show", (_event, bounds) => attachBrowserView(bounds));
    ipcMain.handle("sofia:browser:hide", () => hideBrowserView());
    ipcMain.handle("sofia:browser:openUrl", (_event, url, provider) => openBrowserUrlForAutomation(url, provider));
    ipcMain.handle("sofia:browser:navigate", (_event, url) => {
      const view = getActiveBrowserView() ?? createBrowserTab("about:blank", { select: true }).view;
      view.webContents.loadURL(normalizeBrowserUrl(url));
    });
    ipcMain.handle("sofia:browser:back", () => {
      const webContents = getActiveWebContents();
      if (webContents?.navigationHistory.canGoBack()) webContents.navigationHistory.goBack();
    });
    ipcMain.handle("sofia:browser:forward", () => {
      const webContents = getActiveWebContents();
      if (webContents?.navigationHistory.canGoForward()) webContents.navigationHistory.goForward();
    });
    ipcMain.handle("sofia:browser:reload", () => getActiveWebContents()?.reload());
    ipcMain.handle("sofia:browser:stop", () => getActiveWebContents()?.stop());
    ipcMain.handle("sofia:browser:bounds", (_event, bounds) => {
      lastBrowserBounds = bounds;
      if (!browserViewVisible || !(bounds.width > 0) || !(bounds.height > 0)) return;
      // A dragged Peek is the card under the pointer: the shield has to keep up
      // with it frame by frame, or the drag would leave its own pointer behind.
      if (browserPresentation === "peek") syncPeekShield(scaleRendererBounds(bounds));
      // Panel resize: bounds and fit scale change, the tab viewport does not.
      void applyTabViewport(activeBrowserTabId);
    });
    ipcMain.handle("sofia:browser:state", () => browserStatePayload());
    ipcMain.handle("sofia:browser:createTab", (_event, url) => {
      const target = typeof url === "string" && url.trim() ? url : BROWSER_NEW_TAB_URL;
      const tab = createBrowserTab(target, { select: true });
      return { tabId: tab.tabId };
    });
    ipcMain.handle("sofia:browser:closeTab", (_event, tabId) => closeBrowserTab(tabId == null ? undefined : String(tabId)));
    ipcMain.handle("sofia:browser:closeAllTabs", () => closeAllBrowserTabs());
    ipcMain.handle("sofia:browser:selectTab", (_event, tabId) => selectBrowserTab(String(tabId ?? "")).tabId);
    ipcMain.handle("sofia:browser:reorderTabs", (_event, tabIds) => reorderBrowserTabs(tabIds));
    ipcMain.handle("sofia:browser:listTabs", () => listBrowserTabs());
    ipcMain.handle("sofia:browser:setViewport", (_event, tabId, viewport) => setBrowserTabViewport(tabId, viewport));
    ipcMain.handle("sofia:browser:setPresentation", (_event, mode) => setBrowserPresentation(mode));
    ipcMain.handle("sofia:browser:peekChrome", (_event, chrome) => setPeekShieldChrome(chrome));
    ipcMain.on(PEEK_SHIELD_READY_CHANNEL, (event) => {
      if (event.sender !== peekShieldView?.webContents) return;
      peekShieldReady = true;
      sendPeekShieldChrome();
    });
    ipcMain.on(PEEK_SHIELD_POINTER_CHANNEL, (event, payload) => {
      if (event.sender !== peekShieldView?.webContents) return;
      handlePeekShieldPointer(payload);
    });
    ipcMain.on(PEEK_SHIELD_ACTION_CHANNEL, (event, action) => {
      if (event.sender !== peekShieldView?.webContents) return;
      handlePeekShieldAction(action);
    });
    ipcMain.handle("sofia:browser:setZoom", (_event, tabId, zoom) => setBrowserTabZoom(tabId, zoom));
  ipcMain.handle("sofia:browser:pan", (_event, tabId, pan) => setBrowserTabPan(tabId, pan));
    ipcMain.handle("sofia:browser:agentLease", (_event, action, payload) => updateAgentLease(action, payload));
    ipcMain.handle("sofia:browser:setProxy", (_event, proxy) => setBrowserProxy(proxy));
    ipcMain.handle("sofia:browser:getProxy", () => browserProxyState());
    ipcMain.handle("sofia:browser:toolbarMenu", (_event, tabId, kind, point) => showBrowserToolbarMenu(tabId, kind, point));
    ipcMain.handle("sofia:browser:find", (_event, tabId, text, forward = true) => {
      const contents = requireBrowserTab(tabId).view.webContents;
      if (!text) return contents.stopFindInPage("clearSelection");
      return contents.findInPage(String(text), { forward, findNext: true });
    });
    ipcMain.handle("sofia:browser:tabContextMenu", (_event, tabId, point) => showBrowserTabContextMenu(tabId, point));
    ipcMain.handle("sofia:browser:destroy", () => destroyBrowserView());
    ipcMain.on("sofia:menu-overlay:ready", (event) => {
      if (event.sender !== menuOverlayView?.webContents) return;
      markMenuOverlayReady(menuOverlayView);
    });
    ipcMain.on("sofia:menu-overlay:choose", (event, payload) => {
      if (event.sender !== menuOverlayView?.webContents) return;
      void handleMenuOverlayChoice(payload).catch((error) => console.warn("[browser] menu action failed", error));
    });
    ipcMain.on("sofia:menu-overlay:close", (event, payload) => {
      if (event.sender !== menuOverlayView?.webContents) return;
      if (payload?.requestId && payload.requestId !== menuOverlayRequest?.id) return;
      hideMenuOverlay();
    });
    ipcMain.on("sofia:menu-overlay:dismiss", (event) => {
      if (event.sender === menuOverlayView?.webContents) return;
      hideMenuOverlay();
    });
  }

  return {
    destroy: destroyBrowserView,
    isMainWindowAllowedNavigation,
    registerIpc,
    routeBlockedMainWindowNavigation,
    createTargetForAgent,
  };
}
