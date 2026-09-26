/** @jsxImportSource react */
// The built-in browser's chrome: toolbar, viewport and zoom controls, canvas
// scrollbars, and the page-error shell. Split out of side-panel.tsx so the
// panel shell stays about tabs while this stays about the view.
import * as React from "react";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  Globe,
  Monitor,
  RotateCw,
  X,
} from "lucide-react";

import {
  BROWSER_VIEWPORT_PRESETS,
  BROWSER_ZOOM_STEPS,
  browserPanThumbLength,
  browserToolbarDensity,
  browserUrlParts,
  browserViewportLabel,
  browserViewportPresetId,
  browserZoomLabel,
  formatBrowserScalePercent,
  normalizeBrowserViewport,
  type BrowserToolbarDensity,
} from "@/app/lib/browser-tab-state";
import type { BrowserRect, BrowserViewport, BrowserZoom } from "@/app/lib/desktop-types";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import {
  type BrowserPalette,
  BrowserViewportPalette,
  BrowserViewportTrigger,
  BrowserZoomPalette,
  BrowserZoomTrigger,
} from "./browser-view-menus";
import { type BrowserPanelTab } from "./panel-tab-store";
import { useSetBrowserViewport, useSetBrowserZoom } from "./use-side-panel-tabs";
import { getElectronBrowser, hasNativeBrowserOccluder, nativeBrowserBoundsFor, sameBounds } from "./utils";

const MIN_VISIBLE_CANVAS_PX = 48;
const nativeBoundsFor = nativeBrowserBoundsFor;

type BrowserViewProps = {
  sessionId: string;
  tab: BrowserPanelTab;
  onClose: () => void;
};

export function BrowserView({
  sessionId,
  tab,
  onClose,
}: BrowserViewProps) {
  const isAvailable = Boolean(getElectronBrowser());
  const setBrowserViewport = useSetBrowserViewport();
  const setBrowserZoom = useSetBrowserZoom();

  const [urlInput, setUrlInput] = React.useState(tab.url);
  const [urlFocused, setUrlFocused] = React.useState(false);
  const [panelWidth, setPanelWidth] = React.useState(0);
  const [palette, setPalette] = React.useState<BrowserPalette>(null);
  const canvasRef = React.useRef<HTMLDivElement>(null);
  const urlInputRef = React.useRef<HTMLInputElement>(null);
  const shownRef = React.useRef(false);
  const boundsFrameRef = React.useRef<number | null>(null);
  const panelWidthRef = React.useRef(0);
  const lastBoundsRef = React.useRef<{ x: number; y: number; width: number; height: number } | null>(null);

  const density = browserToolbarDensity(panelWidth);
  // The canvas can only be *larger* than the panel when a virtual viewport is
  // pinned at actual size or a custom scale, so the strips only exist then.
  const applied = tab.appliedViewport;
  const responsiveSize = tab.viewport.mode === "responsive" ? tab.viewport : null;
  const panGeometry = applied && responsiveSize
    ? {
        horizontal: {
          contentLength: responsiveSize.width * applied.scale,
          overflow: applied.overflow.x,
          pan: applied.pan.x,
        },
        vertical: {
          contentLength: responsiveSize.height * applied.scale,
          overflow: applied.overflow.y,
          pan: applied.pan.y,
        },
      }
    : null;
  const requiredPan = { x: applied?.pan.x ?? 0, y: applied?.pan.y ?? 0 };
  const horizontalPan = panGeometry && panGeometry.horizontal.overflow > 0 ? panGeometry.horizontal : null;
  const verticalPan = panGeometry && panGeometry.vertical.overflow > 0 ? panGeometry.vertical : null;
  const responsiveViewport = tab.viewport.mode === "responsive";
  const pageFailed = tab.pageState.status === "error";
  const pageLoading = tab.pageState.status === "loading";
  const agentDisconnected = tab.agentState.status === "error";
  const urlParts = browserUrlParts(tab.url);

  // The page is a native view painted over this DOM, and a native view cannot
  // be z-ordered under React. The error shell is therefore only reachable if
  // the view steps aside, which the bounds loop below enforces every frame.
  const suppressedRef = React.useRef(false);
  suppressedRef.current = pageFailed;

  React.useEffect(() => {
    if (!urlFocused) {
      setUrlInput(tab.url);
    }
  }, [tab.id, tab.url, urlFocused]);

  // Push the tab's durable viewport and zoom to the native view whenever this
  // tab becomes visible or the user changes them. Panel resizes never come
  // through here, so resizing can only rescale — never rewrite — the viewport.
  React.useEffect(() => {
    if (!isAvailable) {
      return;
    }

    void getElectronBrowser()?.setViewport?.(tab.id, tab.viewport);
  }, [isAvailable, tab.id, tab.viewport]);

  React.useEffect(() => {
    if (!isAvailable) {
      return;
    }

    void getElectronBrowser()?.setZoom?.(tab.id, tab.zoom);
  }, [isAvailable, tab.id, tab.zoom]);

  const navigate = React.useCallback(() => {
    void getElectronBrowser()?.navigate?.(urlInput);
  }, [urlInput]);

  const back = React.useCallback(() => {
    void getElectronBrowser()?.back?.();
  }, []);

  const forward = React.useCallback(() => {
    void getElectronBrowser()?.forward?.();
  }, []);

  const reload = React.useCallback(() => {
    void getElectronBrowser()?.reload?.();
  }, []);

  const stop = React.useCallback(() => {
    void getElectronBrowser()?.stop?.();
  }, []);

  const handleUrlKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      navigate();
      urlInputRef.current?.blur();
      return;
    }

    if (event.key === "Escape") {
      urlInputRef.current?.blur();
    }
  }, [navigate]);

  // Reading mode and editing mode are different: the resting address bar shows
  // host/path hierarchy as text, and focusing it swaps in the real editable URL.
  const togglePalette = React.useCallback((kind: "viewport" | "zoom") => {
    setPalette((current) => (current === kind ? null : kind));
  }, []);

  const focusUrl = React.useCallback(() => {
    setUrlFocused(true);
    window.requestAnimationFrame(() => {
      urlInputRef.current?.focus();
      urlInputRef.current?.select();
    });
  }, []);

  const blurUrl = React.useCallback(() => {
    setUrlFocused(false);
  }, []);

  React.useLayoutEffect(() => {
    const browser = getElectronBrowser();
    const canvas = canvasRef.current;
    if (!browser || !canvas || !isAvailable) {
      return;
    }

    const bounds = nativeBoundsFor(canvas);
    if (!bounds) {
      return;
    }

    browser.setBounds?.(bounds);
    lastBoundsRef.current = bounds;
  });

  React.useLayoutEffect(() => {
    const browser = getElectronBrowser();
    const canvas = canvasRef.current;

    if (!browser || !canvas || !isAvailable) {
      browser?.hide?.();
      shownRef.current = false;
      lastBoundsRef.current = null;

      if (boundsFrameRef.current != null) {
        window.cancelAnimationFrame(boundsFrameRef.current);
        boundsFrameRef.current = null;
      }

      return;
    }

    let disposed = false;

    const resetNativeView = async () => {
      await browser.hide?.();

      if (disposed) {
        return;
      }

      shownRef.current = false;
      lastBoundsRef.current = null;
      boundsFrameRef.current = window.requestAnimationFrame(watchBounds);
    };

    const syncBounds = () => {
      const canvasRect = canvas.getBoundingClientRect();

      // Toolbar density only needs whole pixels, and the ref guard keeps a
      // resize drag from re-rendering React more than once per real change.
      if (Math.round(canvasRect.width) !== panelWidthRef.current) {
        panelWidthRef.current = Math.round(canvasRect.width);
        setPanelWidth(panelWidthRef.current);
      }

      const bounds = nativeBoundsFor(canvas);
      const degenerate =
        !bounds || bounds.width < MIN_VISIBLE_CANVAS_PX || bounds.height < MIN_VISIBLE_CANVAS_PX;

      if (degenerate || suppressedRef.current || hasNativeBrowserOccluder()) {
        if (shownRef.current) {
          browser.hide?.();
          shownRef.current = false;
          lastBoundsRef.current = null;
        }

        return;
      }

      if (!shownRef.current) {
        browser.show?.(bounds);
        shownRef.current = true;
        lastBoundsRef.current = bounds;
        return;
      }

      if (!sameBounds(lastBoundsRef.current, bounds)) {
        browser.setBounds?.(bounds);
        lastBoundsRef.current = bounds;
      }
    };

    const watchBounds = () => {
      syncBounds();
      boundsFrameRef.current = window.requestAnimationFrame(watchBounds);
    };

    void resetNativeView();

    const observer = new ResizeObserver(syncBounds);

    observer.observe(canvas);
    window.addEventListener("resize", syncBounds);
    window.addEventListener("scroll", syncBounds, true);

    return () => {
      disposed = true;
      observer.disconnect();
      window.removeEventListener("resize", syncBounds);
      window.removeEventListener("scroll", syncBounds, true);

      if (boundsFrameRef.current != null) {
        window.cancelAnimationFrame(boundsFrameRef.current);
        boundsFrameRef.current = null;
      }

      browser.hide?.();
      shownRef.current = false;
      lastBoundsRef.current = null;
    };
  }, [isAvailable]);

  return (
    <>
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border bg-dls-canvas px-2 mac:bg-dls-canvas/80 mac:backdrop-blur-2xl mac:backdrop-saturate-150">
        {isAvailable ? (
          <>
            <Tooltip>
              <TooltipTrigger
                render={(
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={back}
                    disabled={!tab.canGoBack}
                    aria-label="Go back"
                  >
                    <ArrowLeft />
                  </Button>
                )}
              />
              <TooltipContent>Back</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={(
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={forward}
                    disabled={!tab.canGoForward}
                    aria-label="Go forward"
                  >
                    <ArrowRight />
                  </Button>
                )}
              />
              <TooltipContent>Forward</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={(
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={pageLoading ? stop : reload}
                    aria-label={pageLoading ? "Stop loading" : "Reload page"}
                  >
                    {pageLoading ? <X /> : <RotateCw />}
                  </Button>
                )}
              />
              <TooltipContent>{pageLoading ? "Stop" : "Reload"}</TooltipContent>
            </Tooltip>
            {urlFocused ? (
              <InputGroup className="mx-1 h-7 flex-1 rounded-md">
                <InputGroupAddon align="inline-start" className="ps-2">
                  <Globe />
                </InputGroupAddon>
                <InputGroupInput
                  ref={urlInputRef}
                  type="text"
                  className="h-7"
                  value={urlInput}
                  onChange={(event) => setUrlInput(event.target.value)}
                  onKeyDown={handleUrlKeyDown}
                  onFocus={() => setUrlFocused(true)}
                  onBlur={blurUrl}
                  placeholder="Enter URL..."
                  spellCheck={false}
                  autoComplete="off"
                  aria-label="Address"
                />
              </InputGroup>
            ) : (
              <button
                type="button"
                onClick={focusUrl}
                aria-label="Address"
                className="mx-1 flex h-7 min-w-0 flex-1 items-center gap-1 rounded-md px-2 text-left text-xs hover:bg-foreground/5 focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
              >
                {urlParts ? (
                  <>
                    <span className="truncate font-medium text-foreground">{urlParts.host}</span>
                    {urlParts.rest ? (
                      <span className="truncate text-foreground/70">{urlParts.rest}</span>
                    ) : null}
                    {urlParts.insecure && !urlParts.loopback ? (
                      <span className="shrink-0 text-[10px] text-amber-600 dark:text-amber-500">Not secure</span>
                    ) : null}
                  </>
                ) : (
                  <span className="truncate text-muted-foreground">{tab.url || "Blank tab"}</span>
                )}
              </button>
            )}
            <BrowserViewportTrigger
              viewport={tab.viewport}
              density={density}
              open={palette === "viewport"}
              onToggle={() => togglePalette("viewport")}
            />
            {agentDisconnected ? (
              <Tooltip>
                <TooltipTrigger
                  render={(
                    <span
                      className="flex size-6 shrink-0 items-center justify-center text-amber-600 dark:text-amber-500"
                      aria-label="Sofia cannot control this page"
                    >
                      <AlertTriangle className="size-3.5" />
                    </span>
                  )}
                />
                <TooltipContent>Sofia can&apos;t currently control this page.</TooltipContent>
              </Tooltip>
            ) : null}
          </>
        ) : (
          <p className="px-2 text-sm text-muted-foreground">
            Browser panel is only available in the desktop app.
          </p>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onClose}
          title="Close panel"
          aria-label="Close panel"
        >
          <X />
        </Button>
      </div>
      {isAvailable && responsiveViewport ? (
        <BrowserResponsiveBar
          viewport={tab.viewport}
          zoom={tab.zoom}
          appliedScale={tab.appliedViewport?.scale ?? null}
          density={density}
          palette={palette}
          onTogglePalette={togglePalette}
        />
      ) : null}
      {/* Palettes live above the canvas: a floating menu would sit under the
          native page, and detaching the page to show one blanks the browser. */}
      {palette === "viewport" ? (
        <BrowserViewportPalette
          viewport={tab.viewport}
          onSelect={(viewport) => {
            setBrowserViewport(sessionId, tab.id, viewport);
            setPalette(null);
          }}
        />
      ) : null}
      {palette === "zoom" && responsiveViewport ? (
        <BrowserZoomPalette
          zoom={tab.zoom}
          appliedScale={tab.appliedViewport?.scale ?? null}
          onSelect={(zoom) => {
            setBrowserZoom(sessionId, tab.id, zoom);
            setPalette(null);
          }}
        />
      ) : null}
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex min-h-0 flex-1">
          <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
            {isAvailable ? (
              <div ref={canvasRef} data-testid="browser-canvas" className="h-full overflow-hidden" />
            ) : null}
            {isAvailable && pageFailed ? <BrowserPageError tab={tab} onReload={reload} /> : null}
          </div>
          {verticalPan ? (
            <BrowserPanTrack
              orientation="vertical"
              contentLength={verticalPan.contentLength}
              overflow={verticalPan.overflow}
              pan={verticalPan.pan}
              onPan={(pan) => {
                void getElectronBrowser()?.pan?.(tab.id, { x: requiredPan.x, y: pan });
              }}
            />
          ) : null}
        </div>
        {horizontalPan ? (
          <BrowserPanTrack
            orientation="horizontal"
            contentLength={horizontalPan.contentLength}
            overflow={horizontalPan.overflow}
            pan={horizontalPan.pan}
            onPan={(pan) => {
              void getElectronBrowser()?.pan?.(tab.id, { x: pan, y: requiredPan.y });
            }}
          />
        ) : null}
      </div>
    </>
  );
}

function browserHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

type BrowserResponsiveBarProps = {
  viewport: BrowserViewport;
  zoom: BrowserZoom;
  appliedScale: number | null;
  density: BrowserToolbarDensity;
  palette: BrowserPalette;
  onTogglePalette: (palette: "viewport" | "zoom") => void;
};

/**
 * Secondary row, revealed only for a virtual viewport. Ordinary browsing keeps
 * the full panel height. Its controls open the palettes rather than popovers,
 * because a popover would be painted underneath the native page.
 */
function BrowserResponsiveBar({
  viewport,
  zoom,
  appliedScale,
  density,
  palette,
  onTogglePalette,
}: BrowserResponsiveBarProps) {
  const compactLabel = viewport.mode === "responsive"
    ? `${viewport.width}×${viewport.height}`
    : browserViewportLabel(viewport);

  return (
    <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border/60 bg-muted/30 px-2.5 text-[11px] text-muted-foreground">
      {density === "full" ? (
        <span className="flex shrink-0 items-center gap-1 font-medium text-foreground/80">
          <Monitor className="size-3" />
          Responsive
        </span>
      ) : null}
      <Button
        variant="ghost"
        size="sm"
        aria-label="Viewport size"
        aria-expanded={palette === "viewport"}
        data-testid="browser-viewport-size-trigger"
        onClick={() => onTogglePalette("viewport")}
        className={cn(
          "h-6 shrink-0 gap-1 px-2 text-[11px] font-normal tabular-nums",
          palette === "viewport" && "bg-foreground/10 text-foreground",
        )}
      >
        {density === "full" ? browserViewportLabel(viewport) : compactLabel}
        <ChevronDown className={cn("size-3 transition-transform", palette === "viewport" && "rotate-180")} />
      </Button>
      <BrowserZoomTrigger
        zoom={zoom}
        appliedScale={appliedScale}
        density={density}
        open={palette === "zoom"}
        onToggle={() => onTogglePalette("zoom")}
      />
    </div>
  );
}

type BrowserPanTrackProps = {
  orientation: "vertical" | "horizontal";
  contentLength: number;
  overflow: number;
  pan: number;
  onPan: (pan: number) => void;
};

/**
 * Scrollbar for the browser canvas.
 *
 * It lives *outside* the native view's rect on purpose: a native view paints
 * over DOM, so an overlay scrollbar would be invisible, while a reserved strip
 * is both visible and draggable. Only rendered when the canvas really overflows.
 */
function BrowserPanTrack({ orientation, contentLength, overflow, pan, onPan }: BrowserPanTrackProps) {
  const vertical = orientation === "vertical";
  const trackRef = React.useRef<HTMLDivElement>(null);
  const [trackLength, setTrackLength] = React.useState(0);
  const [dragging, setDragging] = React.useState(false);

  React.useLayoutEffect(() => {
    const track = trackRef.current;

    if (!track) {
      return;
    }

    const measure = () => setTrackLength(vertical ? track.clientHeight : track.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(track);
    return () => observer.disconnect();
  }, [vertical]);

  const thumbLength = browserPanThumbLength({ contentLength, overflow, trackLength });
  const travel = Math.max(1, trackLength - thumbLength);
  const thumbOffset = overflow > 0 ? (pan / overflow) * travel : 0;
  const step = 60;

  const clampPan = (value: number) => Math.min(Math.max(Math.round(value), 0), overflow);

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();

    const startPosition = vertical ? event.clientY : event.clientX;
    const startPan = pan;
    const captureTarget = event.currentTarget;
    setDragging(true);

    try {
      captureTarget.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic pointers cannot capture; the window listeners still work.
    }

    const handleMove = (moveEvent: PointerEvent) => {
      const position = vertical ? moveEvent.clientY : moveEvent.clientX;
      onPan(clampPan(startPan + ((position - startPosition) * overflow) / travel));
    };

    const handleUp = () => {
      setDragging(false);
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      window.removeEventListener("pointercancel", handleUp);

      try {
        captureTarget.releasePointerCapture(event.pointerId);
      } catch {
        // Already released.
      }
    };

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    window.addEventListener("pointercancel", handleUp);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const forward = vertical ? "ArrowDown" : "ArrowRight";
    const backward = vertical ? "ArrowUp" : "ArrowLeft";

    if (event.key === forward) {
      event.preventDefault();
      onPan(clampPan(pan + step));
      return;
    }

    if (event.key === backward) {
      event.preventDefault();
      onPan(clampPan(pan - step));
    }
  };

  return (
    <div
      ref={trackRef}
      data-testid={vertical ? "browser-pan-vertical" : "browser-pan-horizontal"}
      className={cn(
        "relative shrink-0 bg-muted/40",
        vertical ? "w-2.5 cursor-col-resize" : "h-2.5 cursor-row-resize",
      )}
    >
      <div
        role="slider"
        tabIndex={0}
        aria-label={vertical ? "Scroll browser canvas vertically" : "Scroll browser canvas horizontally"}
        aria-orientation={vertical ? "vertical" : "horizontal"}
        aria-valuemin={0}
        aria-valuemax={overflow}
        aria-valuenow={Math.round(pan)}
        data-testid={vertical ? "browser-pan-thumb-vertical" : "browser-pan-thumb-horizontal"}
        onPointerDown={handlePointerDown}
        onKeyDown={handleKeyDown}
        className={cn(
          "absolute rounded-full bg-foreground/25 hover:bg-foreground/40 focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
          dragging && "bg-foreground/50",
          vertical ? "inset-x-0.5" : "inset-y-0.5",
        )}
        style={vertical ? { height: thumbLength, top: thumbOffset } : { width: thumbLength, left: thumbOffset }}
      />
    </div>
  );
}

type BrowserPageErrorProps = {
  tab: BrowserPanelTab;
  onReload: () => void;
};

/** Page failure. Kept separate from agent failure, which never hides the page. */
function BrowserPageError({ tab, onReload }: BrowserPageErrorProps) {
  const parts = browserUrlParts(tab.url);
  const host = parts?.host ?? browserHost(tab.url);
  const description = tab.pageState.error?.description;

  return (
    <div
      data-testid="browser-page-error"
      className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-dls-canvas p-6 text-center"
    >
      <p className="text-sm font-medium text-foreground">
        Can&apos;t reach {host || "this page"}
      </p>
      <p className="max-w-xs text-xs text-muted-foreground">
        {description ? `${description}. ` : ""}
        {parts?.loopback ? "The development server may have stopped." : "The page didn't load."}
      </p>
      <Button variant="outline" size="sm" onClick={onReload}>Reload</Button>
    </div>
  );
}

