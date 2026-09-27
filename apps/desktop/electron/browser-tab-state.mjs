// Ownership model for the built-in browser panel.
//
// Durable browser state belongs to the user and to the tab
// (`createBrowserTabRuntimeState`). Agent control is a temporary lease over that
// state (`createAgentLeaseRegistry`) and is never authoritative for it. Keeping
// both — plus the viewport/emulation plan — in this Electron-free module is what
// makes the ownership rules unit testable without a running app.
//
// Invariants enforced here:
// - The page viewport is derived from the tab alone. `setBounds()` stays the
//   authority for page dimensions only in `panel` mode.
// - Agent leases cannot change, clear, or reset durable tab state, so attaching
//   and detaching an agent never drops a responsive viewport.
// - Fit scaling reacts to panel resizes without mutating viewport dimensions.

/** @typedef {{ x: number, y: number, width: number, height: number }} BrowserRect */
/** @typedef {{ x: number, y: number }} BrowserPanOffset */
/** @typedef {{ scale: number, pan: BrowserPanOffset, overflow: BrowserPanOffset }} BrowserAppliedViewport */
/**
 * `panel` follows the physical panel width (useful for responsive testing).
 * `responsive` pins a virtual viewport that is scaled into the panel.
 * @typedef {{ mode: "panel" } | { mode: "responsive", width: number, height: number, deviceScaleFactor: number }} BrowserViewport
 */
/** @typedef {{ mode: "fit" } | { mode: "actual" } | { mode: "custom", scale: number }} BrowserZoom */
/** @typedef {{ code: number, description: string, url: string }} BrowserPageError */
/** @typedef {{ status: "idle" | "loading" | "ready" | "error", error?: BrowserPageError }} BrowserPageState */
/** @typedef {{ message: string, at: number }} BrowserAgentError */
/** @typedef {{ status: "detached" | "requesting" | "attached" | "paused" | "error", error?: BrowserAgentError }} BrowserAgentState */
/** @typedef {{ tabId: string, viewport: BrowserViewport, zoom: BrowserZoom, pan: BrowserPanOffset, pageState: BrowserPageState, agentState: BrowserAgentState, appliedViewport: BrowserAppliedViewport | null, appliedBounds: BrowserRect | null }} BrowserTabRuntimeState */
/** @typedef {{ dom: boolean, screenshots: boolean, network: boolean, console: boolean, input: boolean }} AgentBrowserCapabilities */
/** @typedef {{ capabilities?: Partial<AgentBrowserCapabilities>, cdpSessionId?: string | null }} AgentLeaseOptions */
/** @typedef {{ leaseId: string, tabId: string, status: "attaching" | "attached" | "paused" | "detaching" | "error", error?: BrowserAgentError, cdpSessionId: string | null, acquiredAt: number, lastActivityAt: number, capabilities: AgentBrowserCapabilities }} AgentBrowserLease */

export const MIN_VIEWPORT_DIMENSION = 64;
export const MAX_VIEWPORT_DIMENSION = 16000;
export const MIN_ZOOM_VALUE = 0.1;
export const MAX_ZOOM_VALUE = 5;
export const DEFAULT_DEVICE_SCALE_FACTOR = 1;

// Device-mode letterboxing is painted by the native view's own background, not
// by the page: the area outside the emulated frame would otherwise be the
// default white and read as part of the page. A responsive viewport uses the
// panel canvas tone (--slate-3) instead, so the frame edge is obvious.
export const BROWSER_PAGE_BACKGROUND = "#ffffff";
export const BROWSER_SURROUND_BACKGROUND_LIGHT = "#f0f0f3";
export const BROWSER_SURROUND_BACKGROUND_DARK = "#212225";

/**
 * Breathing room kept between a fitted device frame and the panel edges.
 * Without it `fit` scales the frame to the panel's exact width, so the page
 * runs edge to edge and the frame's right edge disappears into the panel —
 * the page reads as if it had spilled out of its own frame. The margin keeps
 * the letterbox visible on every side.
 */
export const RESPONSIVE_FRAME_MARGIN_PX = 16;

/**
 * Background the native browser view should paint behind the page.
 * @param {{ responsive: boolean, dark: boolean }} options
 */
export function browserViewBackground({ responsive, dark }) {
  if (!responsive) return BROWSER_PAGE_BACKGROUND;
  return dark ? BROWSER_SURROUND_BACKGROUND_DARK : BROWSER_SURROUND_BACKGROUND_LIGHT;
}

/**
 * Effective page viewport for the floating Peek preview.
 *
 * A ~400px card must not tell the page it is a phone, so a `panel` tab gets a
 * normal desktop breakpoint while it is presented as Peek. This is
 * presentation-derived emulation: it is never written back into the tab's
 * durable viewport, and an explicit responsive preset always wins.
 */
export const BROWSER_PEEK_VIEWPORT = {
  mode: "responsive",
  width: 1280,
  height: 800,
  deviceScaleFactor: 1,
};

/**
 * @param {unknown} viewport The tab's durable viewport.
 * @param {"hidden" | "peek" | "docked" | "expanded"} [presentation]
 */
export function effectiveBrowserViewport(viewport, presentation = "docked") {
  const resolved = normalizeBrowserViewport(viewport);
  if (resolved.mode !== "panel") return resolved;
  if (presentation !== "peek") return resolved;
  return { ...BROWSER_PEEK_VIEWPORT };
}

/** Durable, user-owned state for one built-in browser tab. */
export function createBrowserTabRuntimeState(tabId) {
  return {
    tabId,
    viewport: { mode: "panel" },
    zoom: { mode: "fit" },
    // Where the user has panned an overflowing virtual viewport, in canvas px.
    pan: { x: 0, y: 0 },
    pageState: { status: "idle" },
    agentState: { status: "detached" },
    appliedViewport: null,
    // The native rectangle the page is actually rendered into. Reported so
    // containment (native ⊆ canvas) is an assertable invariant.
    appliedBounds: null,
  };
}

function clampDimension(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.min(Math.max(Math.round(numeric), MIN_VIEWPORT_DIMENSION), MAX_VIEWPORT_DIMENSION);
}

function clampZoomValue(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.min(Math.max(numeric, MIN_ZOOM_VALUE), MAX_ZOOM_VALUE);
}

/** Pan offsets are canvas pixels: finite, non-negative, integral. */
export function normalizePanOffset(input) {
  const candidate = input && typeof input === "object" ? input : {};
  const axis = (value) => {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric > 0 ? Math.round(numeric) : 0;
  };
  return { x: axis(candidate.x), y: axis(candidate.y) };
}

/** @returns {BrowserViewport} */
export function normalizeBrowserViewport(input) {
  const candidate = input && typeof input === "object" ? input : {};
  if (candidate.mode !== "responsive") return { mode: "panel" };
  return {
    mode: "responsive",
    width: clampDimension(candidate.width, 1440),
    height: clampDimension(candidate.height, 900),
    deviceScaleFactor: clampZoomValue(candidate.deviceScaleFactor, DEFAULT_DEVICE_SCALE_FACTOR),
  };
}

/** @returns {BrowserZoom} */
export function normalizeBrowserZoom(input) {
  const candidate = input && typeof input === "object" ? input : {};
  if (candidate.mode === "actual") return { mode: "actual" };
  if (candidate.mode === "custom") return { mode: "custom", scale: clampZoomValue(candidate.scale, 1) };
  return { mode: "fit" };
}

/** @returns {BrowserRect | null} */
export function normalizePanelBounds(input) {
  if (!input || typeof input !== "object") return null;
  const width = Math.round(Number(input.width));
  const height = Math.round(Number(input.height));
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) return null;
  return {
    x: Math.round(Number(input.x) || 0),
    y: Math.round(Number(input.y) || 0),
    width,
    height,
  };
}

/**
 * Peek's desktop breakpoint, expressed as page zoom.
 *
 * Device-metrics emulation is the wrong tool for a floating card. It hands the
 * page a *screen* of its own, and the native view paints that screen wherever
 * it lands — a DOM card cannot clip a native surface, so a card smaller than
 * the emulated screen lets the page spill over the whole app. Zooming the page
 * instead keeps the same desktop breakpoint (a 440px card at 34.375% lays out
 * as 1280px) while the page stays inside the card's own bounds.
 */
export const BROWSER_PEEK_LAYOUT_WIDTH = 1280;

/**
 * @param {unknown} bounds The card, in the same renderer pixels as a panel.
 * @returns {number} Page zoom that lays a desktop page out inside that card.
 */
export function browserPeekLayoutZoom(bounds) {
  const resolved = normalizePanelBounds(bounds);
  if (!resolved) return 1;
  return clampZoomValue(resolved.width / BROWSER_PEEK_LAYOUT_WIDTH, 1);
}

/**
 * Scale that maps an emulated viewport into the available panel. `fit` is the
 * default so a desktop breakpoint stays usable inside a narrow side panel, and
 * it always leaves `RESPONSIVE_FRAME_MARGIN_PX` of letterbox on each side.
 */
export function resolveViewportScale({ viewport, zoom, bounds }) {
  const resolvedZoom = normalizeBrowserZoom(zoom);
  if (resolvedZoom.mode === "custom") return resolvedZoom.scale;
  if (resolvedZoom.mode === "actual") return 1;
  const resolvedViewport = normalizeBrowserViewport(viewport);
  if (resolvedViewport.mode !== "responsive" || !bounds) return 1;
  const availableWidth = Math.max(bounds.width - RESPONSIVE_FRAME_MARGIN_PX * 2, 1);
  const availableHeight = Math.max(bounds.height - RESPONSIVE_FRAME_MARGIN_PX * 2, 1);
  return clampZoomValue(
    Math.min(availableWidth / resolvedViewport.width, availableHeight / resolvedViewport.height),
    1,
  );
}

/**
 * Chromium page zoom factor. In `responsive` mode the zoom is expressed through
 * the emulation scale instead, so the two never multiply.
 */
export function resolvePageZoomFactor(zoom, viewport) {
  if (normalizeBrowserViewport(viewport).mode === "responsive") return 1;
  const resolvedZoom = normalizeBrowserZoom(zoom);
  return resolvedZoom.mode === "custom" ? resolvedZoom.scale : 1;
}

/**
 * The single source of truth for how a tab is laid out natively.
 *
 * Returns the native view bounds plus the CDP emulation to apply. `emulation`
 * of `null` means "no virtual viewport" — the page viewport is the panel.
 * `pan` is clamped to the real overflow, so a viewport that fits can never be
 * nudged off-centre by a stale pan offset.
 * The viewport, zoom, and bounds are accepted as-is because they can arrive
 * from the renderer or from persisted JSON; the normalizers decide what is real.
 * @param {{ viewport?: unknown, zoom?: unknown, panelBounds?: unknown, pan?: BrowserPanOffset }} options
 * @returns {{ bounds: BrowserRect | null, pan: BrowserPanOffset, overflow: BrowserPanOffset, emulation: object | null }}
 */
export function resolveViewportPlan({ viewport, zoom, panelBounds, pan }) {
  const bounds = normalizePanelBounds(panelBounds);
  const resolvedViewport = normalizeBrowserViewport(viewport);
  if (resolvedViewport.mode !== "responsive" || !bounds) {
    return { bounds, pan: { x: 0, y: 0 }, overflow: { x: 0, y: 0 }, emulation: null };
  }

  const scale = resolveViewportScale({ viewport: resolvedViewport, zoom, bounds });
  const overflow = {
    x: Math.max(0, Math.round(resolvedViewport.width * scale - bounds.width)),
    y: Math.max(0, Math.round(resolvedViewport.height * scale - bounds.height)),
  };
  const requestedPan = normalizePanOffset(pan);
  const clampedPan = {
    x: Math.min(requestedPan.x, overflow.x),
    y: Math.min(requestedPan.y, overflow.y),
  };
  // Position the emulated frame the way DevTools device mode does: offsets are
  // expressed in emulated coordinates, so a fitted viewport is centered and an
  // overflowing one can be panned without moving the native view at all.
  const offsetX = Math.max((bounds.width / scale - resolvedViewport.width) / 2, 0);
  const offsetY = Math.max((bounds.height / scale - resolvedViewport.height) / 2, 0);

  // `screenWidth`/`screenHeight` and `positionX`/`positionY` share one space —
  // the emulated page's own DIP, where the view is `width × height` — and
  // Chromium requires the view's origin to be *on* that screen:
  // `0 ≤ position ≤ screen`. Reporting the screen in native device px while the
  // position was in emulated px made both halves wrong together: `fit` bottoms
  // out at MIN_ZOOM_VALUE, so a 200px panel showing a 390px viewport produced a
  // centred position past the end of a screen reported five times too small.
  // Chromium answered "View position should be on the screen" and rejected the
  // whole override, so no emulation applied at all — the page fell back to
  // panel-width layout instead of being resized, which is what made expanding
  // the browser look like a crash.
  const screenWidth = Math.max(Math.round(bounds.width / scale), 1);
  const screenHeight = Math.max(Math.round(bounds.height / scale), 1);

  return {
    bounds,
    pan: clampedPan,
    overflow,
    emulation: {
      width: resolvedViewport.width,
      height: resolvedViewport.height,
      deviceScaleFactor: resolvedViewport.deviceScaleFactor,
      mobile: false,
      scale,
      // A pan can only be expressed while the view's origin stays on the screen:
      // Chromium rejects a negative position outright, and `viewport` is
      // documented as a screenshot-only offset. An overflowing view therefore
      // keeps its pan state but never an off-screen origin.
      positionX: onScreen(Math.round(offsetX - clampedPan.x / scale), screenWidth),
      positionY: onScreen(Math.round(offsetY - clampedPan.y / scale), screenHeight),
      screenWidth,
      screenHeight,
    },
  };
}

/**
 * The emulated view has to sit on its screen, which Chromium enforces before it
 * accepts any of the override.
 * @param {number} value
 * @param {number} size
 */
function onScreen(value, size) {
  return Math.min(Math.max(value, 0), size);
}

/** @typedef {{ sendCommand: (tabId: string, method: string, params: object) => unknown, setBounds: (tabId: string, bounds: BrowserRect | null) => void, release?: (tabId: string) => void }} ViewportControllerOptions */

/**
 * Applies viewport plans to native views.
 *
 * Emulation is written only here, and only from the tab's own viewport, so
 * nothing else in the app can clear a responsive viewport by accident. Repeated
 * applies are deduplicated unless `force` is set (used after navigations, which
 * reset the renderer's override).
 * @param {ViewportControllerOptions} options
 */
export function createViewportController({ sendCommand, setBounds, release = () => {} }) {
  /** Emulation currently applied per tab, keyed by tab id. @type {Map<string, string>} */
  const appliedEmulation = new Map();

  /**
   * @param {{ tabId: string, viewport?: unknown, zoom?: unknown, panelBounds?: unknown, pan?: BrowserPanOffset, force?: boolean }} options
   */
  async function apply({ tabId, viewport, zoom, panelBounds, pan, force = false }) {
    const plan = resolveViewportPlan({ viewport, zoom, panelBounds, pan });
    setBounds(tabId, plan.bounds);

    const key = plan.emulation ? JSON.stringify(plan.emulation) : null;
    const current = appliedEmulation.get(tabId) ?? null;

    // A page viewport that already equals the panel needs no CDP at all, so the
    // default path never attaches a debugger the agent's CDP client might
    // contend with. `force` only re-asserts real emulation, which navigations
    // can drop.
    if (current === key && !(force && key !== null)) return plan;

    if (key === null) {
      await sendCommand(tabId, "Emulation.clearDeviceMetricsOverride", {});
      appliedEmulation.delete(tabId);
      release(tabId);
      return plan;
    }

    await sendCommand(tabId, "Emulation.setDeviceMetricsOverride", plan.emulation);
    appliedEmulation.set(tabId, key);
    return plan;
  }

  function forget(tabId) {
    if (!appliedEmulation.has(tabId)) return;
    appliedEmulation.delete(tabId);
    release(tabId);
  }

  return {
    apply,
    forget,
    appliedEmulation: (tabId) => appliedEmulation.get(tabId) ?? null,
  };
}

function defaultCapabilities() {
  return { dom: true, screenshots: true, network: false, console: false, input: true };
}

/** Lease lifecycle vocabulary mapped onto the tab's agent-health vocabulary. */
function leaseStatusToAgentStatus(status) {
  switch (status) {
    case "attaching":
      return "requesting";
    case "detaching":
      return "detached";
    default:
      return status;
  }
}

/**
 * Temporary agent control. Leases never own durable tab state: releasing,
 * failing, or pausing one leaves the tab exactly as the user left it.
 */
export function createAgentLeaseRegistry() {
  /** @type {Map<string, AgentBrowserLease>} */
  const leases = new Map();
  /** @type {Map<string, string>} */
  const leaseIdByTab = new Map();
  let sequence = 0;

  function touch(lease) {
    lease.lastActivityAt = Date.now();
    return lease;
  }

  /**
   * @param {string} tabId
   * @param {AgentLeaseOptions} [options]
   * @returns {AgentBrowserLease}
   */
  function acquire(tabId, { capabilities, cdpSessionId = null } = {}) {
    const existingId = leaseIdByTab.get(tabId);
    const existing = existingId ? leases.get(existingId) : null;
    if (existing) {
      existing.status = "attached";
      delete existing.error;
      if (cdpSessionId) existing.cdpSessionId = cdpSessionId;
      return touch(existing);
    }

    sequence += 1;
    /** @type {AgentBrowserLease} */
    const lease = {
      leaseId: `lease_${sequence.toString(36)}_${tabId}`,
      tabId,
      status: "attached",
      cdpSessionId,
      acquiredAt: Date.now(),
      lastActivityAt: Date.now(),
      capabilities: { ...defaultCapabilities(), ...(capabilities ?? {}) },
    };
    leases.set(lease.leaseId, lease);
    leaseIdByTab.set(tabId, lease.leaseId);
    return lease;
  }

  function setStatus(leaseId, status) {
    const lease = leases.get(leaseId);
    if (!lease) return null;
    lease.status = status;
    touch(lease);
    if (status === "detaching") leases.delete(leaseId);
    return lease;
  }

  function release(leaseId) {
    const lease = leases.get(leaseId);
    if (!lease) return null;
    leases.delete(leaseId);
    if (leaseIdByTab.get(lease.tabId) === leaseId) leaseIdByTab.delete(lease.tabId);
    lease.status = "detaching";
    touch(lease);
    return lease;
  }

  function releaseTab(tabId) {
    const leaseId = leaseIdByTab.get(tabId);
    return leaseId ? release(leaseId) : null;
  }

  function fail(leaseId, error) {
    const lease = leases.get(leaseId);
    if (!lease) return null;
    lease.status = "error";
    lease.error = { message: String(error?.message ?? error ?? "Browser agent failed"), at: Date.now() };
    touch(lease);
    return lease;
  }

  /** @returns {BrowserAgentState} */
  function statusFor(tabId) {
    const leaseId = leaseIdByTab.get(tabId);
    const lease = leaseId ? leases.get(leaseId) : null;
    if (!lease) return { status: "detached" };
    const status = leaseStatusToAgentStatus(lease.status);
    return lease.error ? { status, error: lease.error } : { status };
  }

  return {
    acquire,
    release,
    releaseTab,
    fail,
    pause: (leaseId) => setStatus(leaseId, "paused"),
    resume: (leaseId) => setStatus(leaseId, "attached"),
    statusFor,
    leaseForTab: (tabId) => {
      const leaseId = leaseIdByTab.get(tabId);
      return leaseId ? leases.get(leaseId) ?? null : null;
    },
    list: () => [...leases.values()],
  };
}

/**
 * Page health transitions. Kept separate from `agentState` so a page that is
 * still usable is never reported as a browser failure.
 * @returns {BrowserPageState}
 */
export function transitionPageState(current, event, error) {
  switch (event) {
    case "start":
      return { status: "loading" };
    case "fail":
      return { status: "error", error };
    case "stop":
      return current?.status === "error" ? current : { status: "ready" };
    default:
      return current?.status === "error" ? current : { status: "ready" };
  }
}
