// Durable browser-tab helpers shared by the panel-tab store and its tests.
//
// The browser tab owns its state; Electron is authoritative only for
// navigation and health. Everything in `mergeBrowserTabNavigation` is the full
// list of fields a native or agent-driven update is allowed to change.

import type {
  BrowserAnnotation,
  BrowserAnnotationTarget,
  BrowserInteractionMode,
  BrowserPanelTab,
  BrowserRect,
  BrowserScroll,
  BrowserTabSyncState,
  BrowserViewport,
  BrowserZoom,
} from "./desktop-types";

export const DEFAULT_BROWSER_VIEWPORT: BrowserViewport = { mode: "panel" };
export const DEFAULT_BROWSER_ZOOM: BrowserZoom = { mode: "fit" };

/** Viewport sizes only; these presets do not change user agent or touch support. */
export type BrowserViewportPreset = {
  id: string;
  label: string;
  width: number;
  height: number;
};

export const BROWSER_VIEWPORT_PRESETS: readonly BrowserViewportPreset[] = [
  { id: "desktop", label: "Desktop", width: 1440, height: 900 },
  { id: "laptop", label: "Laptop", width: 1280, height: 800 },
  { id: "tablet", label: "Tablet", width: 768, height: 1024 },
  { id: "phone", label: "Phone", width: 390, height: 844 },
  { id: "4k", label: "4K", width: 3840, height: 2160 },
  { id: "ipad-air", label: "iPad Air", width: 820, height: 1180 },
  { id: "ipad-mini", label: "iPad Mini", width: 768, height: 1024 },
  { id: "iphone-15-pro", label: "iPhone 15 Pro", width: 393, height: 852 },
  { id: "iphone-15-pro-max", label: "iPhone 15 Pro Max", width: 430, height: 932 },
  { id: "pixel-8", label: "Pixel 8", width: 412, height: 915 },
  { id: "iphone-se", label: "iPhone SE", width: 375, height: 667 },
];

/** Preset zoom steps. Custom values can be typed later; these are enough now. */
export const BROWSER_ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5] as const;

/** Toolbar density breakpoints, local to the browser panel. */
export const BROWSER_TOOLBAR_COMPACT_WIDTH = 720;
export const BROWSER_TOOLBAR_ESSENTIAL_WIDTH = 520;

const MIN_VIEWPORT_DIMENSION = 64;
const MAX_VIEWPORT_DIMENSION = 16000;
const MIN_ZOOM_VALUE = 0.1;
const MAX_ZOOM_VALUE = 5;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function clampDimension(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }

  return clamp(Math.round(value), MIN_VIEWPORT_DIMENSION, MAX_VIEWPORT_DIMENSION);
}

function clampZoomValue(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }

  return clamp(value, MIN_ZOOM_VALUE, MAX_ZOOM_VALUE);
}

// Persisted state is untrusted input: normalizers keep a malformed record from
// turning into a broken tab instead of discarding the whole session.
export function normalizeBrowserViewport(value: unknown): BrowserViewport {
  if (!isRecord(value) || value.mode !== "responsive") {
    return DEFAULT_BROWSER_VIEWPORT;
  }

  return {
    mode: "responsive",
    width: clampDimension(value.width, 1440),
    height: clampDimension(value.height, 900),
    deviceScaleFactor: clampZoomValue(value.deviceScaleFactor, 1),
  };
}

export function normalizeBrowserZoom(value: unknown): BrowserZoom {
  if (!isRecord(value)) {
    return DEFAULT_BROWSER_ZOOM;
  }

  if (value.mode === "actual") {
    return { mode: "actual" };
  }

  if (value.mode === "custom") {
    return { mode: "custom", scale: clampZoomValue(value.scale, 1) };
  }

  return DEFAULT_BROWSER_ZOOM;
}

export function normalizeBrowserInteractionMode(value: unknown): BrowserInteractionMode {
  return value === "annotate" ? "annotate" : "browse";
}

export function normalizeBrowserScroll(value: unknown): BrowserScroll | null {
  if (!isRecord(value) || typeof value.x !== "number" || typeof value.y !== "number") {
    return null;
  }

  return { x: value.x, y: value.y };
}

function normalizeBrowserRect(value: unknown): BrowserRect | null {
  if (!isRecord(value)) {
    return null;
  }

  const { x, y, width, height } = value;

  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    typeof width !== "number" ||
    typeof height !== "number" ||
    ![x, y, width, height].every(Number.isFinite)
  ) {
    return null;
  }

  return { x, y, width, height };
}

function normalizeAnnotationTarget(value: unknown): BrowserAnnotationTarget | null {
  if (!isRecord(value)) {
    return null;
  }

  const boundingBox = normalizeBrowserRect(value.boundingBox);

  if (!boundingBox) {
    return null;
  }

  if (value.type === "region") {
    return { type: "region", boundingBox };
  }

  if (value.type !== "element") {
    return null;
  }

  return {
    type: "element",
    boundingBox,
    ...(typeof value.selector === "string" ? { selector: value.selector } : {}),
    ...(typeof value.domPath === "string" ? { domPath: value.domPath } : {}),
    ...(typeof value.text === "string" ? { text: value.text } : {}),
    ...(typeof value.role === "string" ? { role: value.role } : {}),
  };
}

function normalizeAnnotationStatus(value: unknown): BrowserAnnotation["status"] {
  if (value === "attached" || value === "sent" || value === "resolved") {
    return value;
  }

  return "draft";
}

function normalizeBrowserAnnotation(value: unknown): BrowserAnnotation | null {
  if (!isRecord(value) || typeof value.id !== "string" || !isRecord(value.page)) {
    return null;
  }

  const target = normalizeAnnotationTarget(value.target);

  if (!target || typeof value.comment !== "string") {
    return null;
  }

  return {
    id: value.id,
    page: {
      url: typeof value.page.url === "string" ? value.page.url : "",
      pathname: typeof value.page.pathname === "string" ? value.page.pathname : "",
    },
    target,
    comment: value.comment,
    createdAt: typeof value.createdAt === "number" ? value.createdAt : 0,
    status: normalizeAnnotationStatus(value.status),
  };
}

export function normalizeBrowserAnnotations(value: unknown): BrowserAnnotation[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    const annotation = normalizeBrowserAnnotation(entry);
    return annotation ? [annotation] : [];
  });
}

export function createBrowserPanelTab(id: string): BrowserPanelTab {
  return {
    id,
    type: "browser",
    label: "New tab",
    url: "",
    favicon: null,
    canGoBack: false,
    canGoForward: false,
    pageState: { status: "idle" },
    agentState: { status: "detached" },
    appliedViewport: null,
    appliedBounds: null,
    viewport: DEFAULT_BROWSER_VIEWPORT,
    zoom: DEFAULT_BROWSER_ZOOM,
    interactionMode: "browse",
    annotations: [],
    scroll: null,
  };
}

/** Electron's navigation and health update, applied without touching user state. */
export function mergeBrowserTabNavigation(
  tab: BrowserPanelTab,
  navigation: BrowserTabSyncState,
): BrowserPanelTab {
  return {
    ...tab,
    label: navigation.label,
    url: navigation.url,
    favicon: navigation.favicon,
    canGoBack: navigation.canGoBack,
    canGoForward: navigation.canGoForward,
    pageState: navigation.pageState,
    agentState: navigation.agentState,
    appliedViewport: navigation.appliedViewport,
    appliedBounds: navigation.appliedBounds,
  };
}

export function isSameBrowserPanelTab(left: BrowserPanelTab, right: BrowserPanelTab): boolean {
  return (
    left.id === right.id &&
    left.label === right.label &&
    left.url === right.url &&
    left.favicon === right.favicon &&
    left.canGoBack === right.canGoBack &&
    left.canGoForward === right.canGoForward &&
    JSON.stringify(left.pageState) === JSON.stringify(right.pageState) &&
    JSON.stringify(left.agentState) === JSON.stringify(right.agentState) &&
    JSON.stringify(left.appliedViewport) === JSON.stringify(right.appliedViewport) &&
    JSON.stringify(left.appliedBounds) === JSON.stringify(right.appliedBounds) &&
    JSON.stringify(left.viewport) === JSON.stringify(right.viewport) &&
    JSON.stringify(left.zoom) === JSON.stringify(right.zoom) &&
    left.interactionMode === right.interactionMode &&
    JSON.stringify(left.annotations) === JSON.stringify(right.annotations) &&
    JSON.stringify(left.scroll) === JSON.stringify(right.scroll)
  );
}

/** "Panel" or "1440 × 900" — the viewport control's own label. */
export function browserViewportLabel(viewport: BrowserViewport): string {
  return viewport.mode === "responsive" ? `${viewport.width} × ${viewport.height}` : "Panel";
}

export function browserViewportPresetId(viewport: BrowserViewport): BrowserViewportPreset["id"] | null {
  if (viewport.mode !== "responsive") {
    return null;
  }

  const preset = BROWSER_VIEWPORT_PRESETS.find(
    (candidate) => candidate.width === viewport.width && candidate.height === viewport.height,
  );

  return preset?.id ?? null;
}

export function formatBrowserScalePercent(scale: number): string {
  return `${Math.round(scale * 100)}%`;
}

/**
 * Zoom readout. `fit` shows the scale the runtime actually applied — the user
 * chose Fit, the percentage is only the current consequence of the panel size.
 */
export function browserZoomLabel(zoom: BrowserZoom, appliedScale: number | null): string {
  if (zoom.mode === "actual") {
    return "Actual size";
  }

  if (zoom.mode === "custom") {
    return formatBrowserScalePercent(zoom.scale);
  }

  return typeof appliedScale === "number" ? `Fit · ${formatBrowserScalePercent(appliedScale)}` : "Fit";
}

export type BrowserUrlParts = {
  host: string;
  rest: string;
  insecure: boolean;
  loopback: boolean;
};

/** Host/path split for the unfocused address bar. Null when it isn't a web URL. */
export function browserUrlParts(url: string): BrowserUrlParts | null {
  try {
    const parsed = new URL(url);

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }

    return {
      host: parsed.host,
      rest: `${parsed.pathname}${parsed.search}${parsed.hash}`,
      insecure: parsed.protocol === "http:",
      loopback: parsed.hostname === "localhost" ||
        parsed.hostname === "127.0.0.1" ||
        parsed.hostname === "[::1]",
    };
  } catch {
    return null;
  }
}

export type BrowserToolbarDensity = "full" | "compact" | "essential";

export function browserToolbarDensity(panelWidth: number): BrowserToolbarDensity {
  if (panelWidth >= BROWSER_TOOLBAR_COMPACT_WIDTH) {
    return "full";
  }

  return panelWidth >= BROWSER_TOOLBAR_ESSENTIAL_WIDTH ? "compact" : "essential";
}

/**
 * Scrollbar thumb length for a canvas that may be larger than its track.
 *
 * `contentLength` is the scaled viewport length, `overflow` is how much of it
 * does not fit, and `trackLength` is the visible track. A canvas that fits gets
 * a full-length thumb, which is what makes "no overflow" obvious in the UI.
 */
export function browserPanThumbLength({
  contentLength,
  overflow,
  trackLength,
}: {
  contentLength: number;
  overflow: number;
  trackLength: number;
}): number {
  if (trackLength <= 0) {
    return 0;
  }

  if (overflow <= 0 || contentLength <= 0) {
    return trackLength;
  }

  const visible = Math.max(contentLength - overflow, 0);
  const ratio = Math.min(visible / contentLength, 1);

  return Math.max(Math.min(24, trackLength), Math.min(trackLength, Math.round(trackLength * ratio)));
}
