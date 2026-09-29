/** @jsxImportSource react */
// Floating Peek: a glanceable live browser surface, not a miniature browser.
//
// The page is the same native `WebContentsView` the docked panel renders; only
// its host rectangle changes, so no tab, CDP target, session or agent lease is
// touched when the presentation changes.
//
// Three rules make the card feel like a floating piece of content rather than a
// window that happens to be small:
//
//   geometry   the card is one rectangle owned by the presentation, sized to
//              the shape of the content it holds so the page fills it edge to
//              edge. Page loads, tab switches and titles cannot resize it (the
//              viewport it *renders at* can), and it never changes the
//              conversation's layout.
//   chrome     title, agent status and controls live in the native Peek shield
//              (see `apps/desktop/electron/browser-peek-shield.mjs`) because a
//              native page cannot be painted over by the DOM.
//   intent     a human click opens the browser, a human drag moves the card.
//              Both arrive from the shield; agent CDP input never does.
import * as React from "react";

import type { BrowserPeekChrome, BrowserPanelTab } from "@/app/lib/desktop-types";
import { getResolvedThemeMode, subscribeToTheme } from "@/app/theme";

import {
  BROWSER_PEEK_RADIUS,
  beginPeekDrag,
  browserPeekSize,
  browserPresentationState,
  clampPeekPosition,
  defaultPeekPosition,
  dispatchBrowserPresentation,
  movePeekDrag,
  peekDragPosition,
  snapPeekPosition,
  useBrowserPresentationStore,
  type BrowserPeekDragState,
  type BrowserPeekPosition,
  type BrowserSurfaceSize,
} from "./browser-presentation";
import {
  MIN_VISIBLE_BROWSER_CANVAS_PX,
  getElectronBrowser,
  hasNativeBrowserOccluder,
  nativeBrowserBoundsFor,
  sameBounds,
} from "./utils";

type BrowserPeekProps = {
  tab: BrowserPanelTab;
  /** Tabs beyond the one shown; full tab chrome belongs in docked/expanded. */
  tabCount: number;
  onExpand: () => void;
  onHide: () => void;
};

const NO_SURFACE: BrowserSurfaceSize = { width: 0, height: 0 };
const RESTING_ORIGIN: BrowserPeekPosition = { x: 0, y: 0 };

export function BrowserPeek({ tab, tabCount, onExpand, onHide }: BrowserPeekProps) {
  const shellRef = React.useRef<HTMLDivElement>(null);
  const frameRef = React.useRef<HTMLDivElement>(null);
  const pageRef = React.useRef<HTMLDivElement>(null);
  // Page health is read through a ref so a navigation can never restart (and so
  // never blink) the presentation loop below.
  const pageFailedRef = React.useRef(false);
  const surfaceRef = React.useRef<BrowserSurfaceSize>(NO_SURFACE);
  const dragRef = React.useRef<BrowserPeekDragState | null>(null);
  const positionRef = React.useRef<BrowserPeekPosition>(RESTING_ORIGIN);
  const sizeRef = React.useRef(browserPeekSize());
  const expandRef = React.useRef(onExpand);
  const hideRef = React.useRef(onHide);
  expandRef.current = onExpand;
  hideRef.current = onHide;

  const [surface, setSurface] = React.useState<BrowserSurfaceSize | null>(null);
  const [drag, setDrag] = React.useState<BrowserPeekDragState | null>(null);
  const [frameColor, setFrameColor] = React.useState<string | null>(null);
  const storedPosition = useBrowserPresentationStore((state) => state.state.runtime.peekPosition);
  const dark = React.useSyncExternalStore(subscribeToTheme, getResolvedThemeMode, getResolvedThemeMode) === "dark";

  // The card is the shape of the content it holds, so its size follows the
  // viewport this tab renders at while peeked — never the page's own state.
  const size = React.useMemo(() => browserPeekSize(tab.viewport), [tab.viewport]);
  const available = surface ?? NO_SURFACE;
  const restingPosition = clampPeekPosition(
    storedPosition ?? defaultPeekPosition(available, size),
    available,
    size,
  );
  const position = drag ? peekDragPosition(drag, available, size) : restingPosition;
  positionRef.current = position;
  sizeRef.current = size;
  surfaceRef.current = available;
  pageFailedRef.current = tab.pageState.status === "error";

  // The card floats over the session surface, so that is the rectangle its
  // position is clamped to — never the whole window.
  React.useLayoutEffect(() => {
    const host = shellRef.current?.parentElement;
    if (!host) return;
    const measure = () => {
      const rect = host.getBoundingClientRect();
      setSurface((previous) =>
        previous && previous.width === rect.width && previous.height === rect.height
          ? previous
          : { width: rect.width, height: rect.height },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  // A workspace resize can leave the card hanging off an edge; the stored
  // position is the one that gets corrected, so the fix survives a re-render.
  React.useEffect(() => {
    if (!surface || !storedPosition) return;
    const clamped = clampPeekPosition(storedPosition, surface, size);
    if (clamped.x === storedPosition.x && clamped.y === storedPosition.y) return;
    dispatchBrowserPresentation({ type: "user-move-peek", position: clamped });
  }, [size, surface, storedPosition]);

  // Report the page slot to Electron. Exactly one host reports bounds at a time,
  // because the presentation renders either the docked panel or the card.
  React.useEffect(() => {
    const browser = getElectronBrowser();
    if (!browser) return;

    let frame: number | null = null;
    let last: { x: number; y: number; width: number; height: number } | null = null;

    const tick = () => {
      frame = null;
      const host = shellRef.current;
      const page = pageRef.current;
      const bounds = host && page ? nativeBrowserBoundsFor(page, host) : null;
      const tooSmall =
        !bounds ||
        bounds.width < MIN_VISIBLE_BROWSER_CANVAS_PX ||
        bounds.height < MIN_VISIBLE_BROWSER_CANVAS_PX;

      if (pageFailedRef.current || tooSmall || hasNativeBrowserOccluder(page)) {
        if (last) {
          void browser.hide?.();
          last = null;
        }
      } else if (!last) {
        last = bounds;
        void browser.show?.(bounds);
      } else if (!sameBounds(last, bounds)) {
        last = bounds;
        void browser.setBounds?.(bounds);
      }

      frame = window.requestAnimationFrame(tick);
    };

    frame = window.requestAnimationFrame(tick);
    return () => {
      if (frame != null) window.cancelAnimationFrame(frame);
      // Docking mounts a new browser host in the same commit. Its show may
      // precede this cleanup, so a stale Peek must not hide the docked page.
      if (browserPresentationState().runtime.mode === "peek") void browser.hide?.();
    };
  }, []);

  // Click and drag both come from the shield, because the live page is native.
  React.useEffect(() => {
    const browser = getElectronBrowser();
    const unsubscribePointer = browser?.onBrowserPeekPointer?.((pointer) => {
      if (pointer.phase === "down") {
        const next = beginPeekDrag(positionRef.current);
        dragRef.current = next;
        setDrag(next);
        return;
      }
      let current = dragRef.current;
      if (pointer.phase === "move") {
        if (!current) return;
        const next = movePeekDrag(current, pointer.dx, pointer.dy);
        dragRef.current = next;
        setDrag(next);
        return;
      }
      if (current && pointer.phase === "up") current = movePeekDrag(current, pointer.dx, pointer.dy);
      dragRef.current = null;
      if (current?.dragging) {
        // Even a cancelled native pointer capture must retain the last visible
        // position. Reverting to the origin makes the card jump during a drag.
        const lastPosition = peekDragPosition(current, surfaceRef.current, sizeRef.current);
        dispatchBrowserPresentation({
          type: "user-move-peek",
          position: pointer.phase === "cancel"
            ? lastPosition
            : snapPeekPosition(lastPosition, surfaceRef.current, sizeRef.current),
        });
        setDrag(null);
        return;
      }
      setDrag(null);
      if (pointer.phase === "cancel") return;
      expandRef.current();
    });
    const unsubscribeExpand = browser?.onBrowserPeekActivated?.((intent) => {
      if (intent === "expand") dispatchBrowserPresentation({ type: "user-expand-browser" });
      else expandRef.current();
    });
    const unsubscribeHide = browser?.onBrowserPeekHidden?.(() => hideRef.current());
    return () => {
      unsubscribePointer?.();
      unsubscribeExpand?.();
      unsubscribeHide?.();
    };
  }, []);

  // Chrome is drawn by the shield, so the tab state that feeds it is published
  // from here. The frame colour comes from the card's own resolved background,
  // which keeps the shield's corner masks in step with the theme.
  React.useEffect(() => {
    const element = frameRef.current;
    if (!element) return;
    const resolved = window.getComputedStyle(element).backgroundColor;
    setFrameColor(resolved || null);
  }, [dark]);

  const chrome = React.useMemo<BrowserPeekChrome>(
    () => ({
      title: tab.label || tab.url || "Browser",
      favicon: tab.favicon,
      browsing: tab.agentState.status === "attached",
      tabCount,
      loading: tab.pageState.status === "loading",
      dark,
      frameColor: frameColor ?? (dark ? "#212225" : "#f0f0f3"),
      radius: BROWSER_PEEK_RADIUS,
    }),
    [dark, frameColor, tab.agentState.status, tab.favicon, tab.label, tab.pageState.status, tab.url, tabCount],
  );

  React.useEffect(() => {
    void getElectronBrowser()?.setPeekChrome?.(chrome);
  }, [chrome]);

  const failed = tab.pageState.status === "error";

  return (
    <div
      ref={shellRef}
      data-testid="browser-peek"
      data-native-browser-host
      data-browser-presentation="peek"
      className="pointer-events-none absolute z-30"
      style={{ left: position.x, top: position.y, width: size.width, height: size.height }}
    >
      <div
        ref={frameRef}
        className="absolute inset-0 bg-dls-canvas shadow-[0_18px_55px_rgba(0,0,0,0.30),0_3px_12px_rgba(0,0,0,0.16)] dark:shadow-[0_18px_55px_rgba(0,0,0,0.38),0_3px_12px_rgba(0,0,0,0.20)]"
        style={{ borderRadius: BROWSER_PEEK_RADIUS }}
      />
      {failed ? (
        <div className="absolute inset-0 flex items-center justify-center px-3 text-center text-[11px] text-muted-foreground">
          This page could not be loaded.
        </div>
      ) : null}
      <div ref={pageRef} data-testid="browser-peek-page" className="absolute inset-0" />
    </div>
  );
}
