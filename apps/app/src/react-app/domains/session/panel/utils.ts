import { isElectronRuntime } from "@/app/utils";

import type { BrowserRect } from "@/app/lib/desktop-types";

/**
 * Below this the host is a collapsed panel, not a place to render a page. The
 * native view is hidden entirely rather than shrunk to a sliver: a leftover
 * larger view would otherwise paint over the rest of the app, because a native
 * surface cannot be clipped by the DOM.
 */
export const MIN_VISIBLE_BROWSER_CANVAS_PX = 48;

/**
 * A native view is a square surface and its host is rounded and bordered, so
 * the page is inset by one pixel on the trailing edges. Without it a square
 * white page sits flush against the host and reads as a second window pasted
 * over Sofia instead of content inside it.
 */
const NATIVE_EDGE_INSET_PX = 1;

function toRectBounds(rect: DOMRect): BrowserRect {
  return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
}

function intersectBounds(left: BrowserRect, right: BrowserRect): BrowserRect | null {
  const x = Math.max(left.x, right.x);
  const y = Math.max(left.y, right.y);
  const rightEdge = Math.min(left.x + left.width, right.x + right.width);
  const bottomEdge = Math.min(left.y + left.height, right.y + right.height);
  if (rightEdge <= x || bottomEdge <= y) return null;
  return { x, y, width: rightEdge - x, height: bottomEdge - y };
}

/**
 * The only rectangle ever handed to Electron for a browser surface.
 *
 * The page is a native `WebContentsView`: CSS `overflow` and `border-radius`
 * cannot clip it, so containment is enforced here instead. The canvas rect is
 * clamped to the host that owns it (docked panel or floating preview) and to
 * the window, which gives a hard guarantee that the page can never paint
 * outside the area Sofia granted it. Viewport emulation, zoom, and pan all
 * happen *inside* this rectangle and can never move or grow it.
 */
export function nativeBrowserBoundsFor(canvas: HTMLElement, host?: HTMLElement | null): BrowserRect | null {
  let bounds: BrowserRect | null = toRectBounds(canvas.getBoundingClientRect());

  if (!bounds || bounds.width < 1 || bounds.height < 1) return null;

  const container = host ?? canvas.closest<HTMLElement>('[data-native-browser-host]');
  if (container) {
    bounds = intersectBounds(bounds, toRectBounds(container.getBoundingClientRect()));
  }

  if (!bounds) return null;

  bounds = intersectBounds(bounds, { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight });
  if (!bounds || bounds.width <= NATIVE_EDGE_INSET_PX * 2 || bounds.height <= NATIVE_EDGE_INSET_PX * 2) {
    return null;
  }

  return {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width - NATIVE_EDGE_INSET_PX,
    height: bounds.height - NATIVE_EDGE_INSET_PX,
  };
}

export function getElectronBrowser() {
  if (!isElectronRuntime()) {
    return null;
  }

  return window.__SOFIA_ELECTRON__?.browser ?? null;
}

// Bounds and points are sent in renderer CSS pixels. The Electron main process
// converts them to window device-independent pixels using the authoritative
// webContents zoom factor at apply time, so the renderer never needs to track
// (and can never disagree with) the real zoom state.
export function getNativeMenuPoint(
  el: HTMLElement | null,
  point?: { clientX: number; clientY: number },
) {
  if (point) {
    return { x: point.clientX, y: point.clientY };
  }

  if (!el) {
    return undefined;
  }

  const rect = el.getBoundingClientRect();

  return {
    x: rect.left + 8,
    y: rect.bottom + 4,
  };
}

export function computeBounds(el: HTMLElement) {
  const rect = el.getBoundingClientRect();

  return {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
  };
}

export function sameBounds(
  left: { x: number; y: number; width: number; height: number } | null,
  right: { x: number; y: number; width: number; height: number },
) {
  return Boolean(
    left &&
      left.x === right.x &&
      left.y === right.y &&
      left.width === right.width &&
      left.height === right.height,
  );
}

/**
 * Overlay surfaces that must push the native browser view out of the way.
 *
 * The page is a native `WebContentsView` layered above this DOM, so anything
 * that paints over the page area has to force the page to step aside — a DOM
 * overlay cannot win that compositing order. Dialogs were already covered;
 * Base UI menus and popovers render into a portal that overlaps the page too,
 * which is why an open `Panel ⌄` menu used to appear underneath the page.
 */
const NATIVE_BROWSER_OCCLUDER_SELECTOR = [
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="menu"]',
  '[role="listbox"]',
  '[data-slot="dropdown-menu-content"]',
  '[data-slot="popover-content"]',
].join(", ");

export function hasNativeBrowserOccluder() {
  const overlays = document.querySelectorAll(NATIVE_BROWSER_OCCLUDER_SELECTOR);
  for (const overlay of overlays) {
    if (!(overlay instanceof HTMLElement)) {
      continue;
    }

    if (overlay.offsetParent !== null || overlay.getClientRects().length > 0) {
      return true;
    }
  }
  return false;
}
