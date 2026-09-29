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
  Globe,
  MessageCircle,
  Monitor,
  MousePointer2,
  MoreHorizontal,
  RotateCw,
  X,
} from "lucide-react";

import {
  BROWSER_VIEWPORT_PRESETS,
  BROWSER_ZOOM_STEPS,
  browserPanThumbLength,
  browserToolbarDensity,
  browserUrlParts,
  browserViewportPresetId,
  formatBrowserScalePercent,
  normalizeBrowserViewport,
} from "@/app/lib/browser-tab-state";
import type { BrowserAnnotationTarget, BrowserRect, BrowserViewport, BrowserZoom } from "@/app/lib/desktop-types";
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

import { type BrowserPanelTab, usePanelTabStore } from "./panel-tab-store";
import { browserPresentationState } from "./browser-presentation";
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
  onClose: _onClose,
}: BrowserViewProps) {
  const isAvailable = Boolean(getElectronBrowser());
  const setBrowserViewport = useSetBrowserViewport();
  const setBrowserZoom = useSetBrowserZoom();
  const addBrowserAnnotation = usePanelTabStore((state) => state.addBrowserAnnotation);
  const setBrowserInteractionMode = usePanelTabStore((state) => state.setBrowserInteractionMode);

  const [urlInput, setUrlInput] = React.useState(tab.url);
  const [urlFocused, setUrlFocused] = React.useState(false);
  const [panelWidth, setPanelWidth] = React.useState(0);
  const [responsiveControlsOpen, setResponsiveControlsOpen] = React.useState(false);
  const [findOpen, setFindOpen] = React.useState(false);
  const [findQuery, setFindQuery] = React.useState("");
  const [annotationImage, setAnnotationImage] = React.useState<string | null>(null);
  const [annotationTarget, setAnnotationTarget] = React.useState<BrowserAnnotationTarget | null>(null);
  const [annotationComment, setAnnotationComment] = React.useState("");
  const [annotationError, setAnnotationError] = React.useState<string | null>(null);
  const findInputRef = React.useRef<HTMLInputElement>(null);
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
  suppressedRef.current = pageFailed || annotationImage !== null;

  const closeAnnotation = React.useCallback(() => {
    setAnnotationImage(null);
    setAnnotationTarget(null);
    setAnnotationComment("");
    setAnnotationError(null);
    setBrowserInteractionMode(sessionId, tab.id, "browse");
  }, [sessionId, setBrowserInteractionMode, tab.id]);

  const toggleAnnotation = React.useCallback(async () => {
    if (annotationImage) {
      closeAnnotation();
      return;
    }
    try {
      const image = await getElectronBrowser()?.annotationCapture?.(tab.id);
      if (!image) throw new Error("The page could not be captured.");
      setAnnotationImage(image);
      setAnnotationError(null);
      setBrowserInteractionMode(sessionId, tab.id, "annotate");
    } catch (error) {
      setAnnotationError(error instanceof Error ? error.message : String(error));
    }
  }, [annotationImage, closeAnnotation, sessionId, setBrowserInteractionMode, tab.id]);

  const saveAnnotation = React.useCallback(() => {
    if (!annotationTarget || !annotationComment.trim()) return;
    const comment = annotationComment.trim();
    const annotation = {
      id: crypto.randomUUID(),
      page: { url: tab.url, pathname: (() => { try { return new URL(tab.url).pathname; } catch { return ""; } })() },
      target: annotationTarget,
      comment,
      createdAt: Date.now(),
      status: "attached" as const,
    };
    addBrowserAnnotation(sessionId, tab.id, annotation);
    const targetDescription = annotationTarget.type === "element"
      ? `${annotationTarget.selector ?? "element"}${annotationTarget.text ? ` — ${annotationTarget.text}` : ""}`
      : `region at ${Math.round(annotationTarget.boundingBox.x)}, ${Math.round(annotationTarget.boundingBox.y)} (${Math.round(annotationTarget.boundingBox.width)} × ${Math.round(annotationTarget.boundingBox.height)})`;
    window.dispatchEvent(new CustomEvent("sofia:browser-annotation", {
      detail: { sessionId, text: `On ${tab.url}, look at ${targetDescription}. ${comment}`, image: annotationImage },
    }));
    closeAnnotation();
  }, [addBrowserAnnotation, annotationComment, annotationImage, annotationTarget, closeAnnotation, sessionId, tab.id, tab.url]);

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

  React.useEffect(() => {
    return getElectronBrowser()?.onFindRequested?.(({ tabId }) => {
      if (tabId !== tab.id) return;
      setFindOpen(true);
      window.requestAnimationFrame(() => findInputRef.current?.focus());
    });
  }, [tab.id]);

  const showToolbarMenu = React.useCallback((kind: "browser" | "extensions", event: React.MouseEvent<HTMLButtonElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    void getElectronBrowser()?.showToolbarMenu?.(tab.id, kind, {
      x: bounds.right - 310,
      y: bounds.bottom + 4,
    });
  }, [tab.id]);

  const closeFind = React.useCallback(() => {
    setFindOpen(false);
    setFindQuery("");
    void getElectronBrowser()?.find?.(tab.id, "", true);
  }, [tab.id]);

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

      if (degenerate || suppressedRef.current || hasNativeBrowserOccluder(canvas)) {
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

      if (browserPresentationState().runtime.mode !== "peek") browser.hide?.();
      shownRef.current = false;
      lastBoundsRef.current = null;
    };
  }, [isAvailable]);

  return (
    <>
      <div data-testid="browser-toolbar" className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-dls-canvas px-2 [&_svg]:size-4 [&_svg]:stroke-[1.5]">
        {isAvailable ? (
          <>
            <div data-testid="browser-navigation" className="flex h-8 shrink-0 items-center rounded-full bg-muted/60 px-1">
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
            </div>
            <Button
              variant={annotationImage ? "secondary" : "ghost"}
              size="sm"
              data-testid="browser-annotate"
              aria-pressed={annotationImage !== null}
              onClick={() => void toggleAnnotation()}
              className="h-8 shrink-0 gap-1.5 rounded-full bg-muted/60 px-3 text-xs"
            >
              <MousePointer2 className="size-3.5" />
              {density === "full" ? "Annotate" : null}
            </Button>
            {urlFocused ? (
              <InputGroup className="h-8 min-w-0 flex-1 rounded-full bg-muted/60">
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
                className="flex h-8 min-w-0 flex-1 items-center justify-center gap-1 rounded-full bg-muted/60 px-3 text-center text-xs hover:bg-muted focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
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
            <Button variant="ghost" size="icon-sm" data-testid="browser-viewport-trigger"
              aria-label="Responsive controls" aria-expanded={responsiveControlsOpen}
              className="text-muted-foreground hover:text-foreground"
              onClick={() => { setResponsiveControlsOpen(current => !current); }}>
              <Monitor />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              data-testid="browser-menu-trigger"
              className="text-muted-foreground hover:text-foreground"
              title="Browser menu"
              aria-label="Browser menu"
              onClick={(event) => showToolbarMenu("browser", event)}
            >
              <MoreHorizontal />
            </Button>
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

      </div>
      {annotationError ? <p role="alert" className="px-3 py-1 text-xs text-destructive">{annotationError}</p> : null}
      {isAvailable && findOpen ? (
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-dls-canvas px-2">
          <Input
            ref={findInputRef}
            data-testid="browser-find-input"
            aria-label="Find in page"
            className="h-7 min-w-0 flex-1 text-xs"
            value={findQuery}
            onChange={(event) => {
              setFindQuery(event.target.value);
              void getElectronBrowser()?.find?.(tab.id, event.target.value, true);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") closeFind();
              if (event.key === "Enter") void getElectronBrowser()?.find?.(tab.id, findQuery, !event.shiftKey);
            }}
            placeholder="Find in page"
          />
          <Button variant="ghost" size="icon-sm" aria-label="Close find" onClick={closeFind}>
            <X />
          </Button>
        </div>
      ) : null}
      {isAvailable && responsiveControlsOpen ? (
        <BrowserResponsiveBar
          viewport={tab.viewport}
          zoom={tab.zoom}
          appliedScale={tab.appliedViewport?.scale ?? null}
          onViewportChange={(viewport) => setBrowserViewport(sessionId, tab.id, viewport)}
          onZoomChange={(zoom) => setBrowserZoom(sessionId, tab.id, zoom)}
          onClose={() => { setResponsiveControlsOpen(false); }}
        />
      ) : null}
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex min-h-0 flex-1">
          <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
            {isAvailable ? (
              <div ref={canvasRef} data-testid="browser-canvas" className={cn("h-full overflow-hidden", responsiveViewport && "bg-muted/50")} />
            ) : null}
            {annotationImage ? (
              <BrowserAnnotationOverlay
                image={annotationImage}
                target={annotationTarget}
                comment={annotationComment}
                onCommentChange={setAnnotationComment}
                onSelect={async (selection) => {
                  if (selection.width > 8 || selection.height > 8) {
                    setAnnotationTarget({ type: "region", boundingBox: selection });
                    return;
                  }
                  try {
                    const element = await getElectronBrowser()?.annotationTarget?.(tab.id, selection.x, selection.y);
                    setAnnotationTarget(element
                      ? { type: "element", ...element }
                      : { type: "region", boundingBox: { ...selection, width: 1, height: 1 } });
                  } catch {
                    setAnnotationTarget({ type: "region", boundingBox: { ...selection, width: 1, height: 1 } });
                  }
                }}
                onSave={saveAnnotation}
                onCancel={closeAnnotation}
              />
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

function BrowserAnnotationOverlay({
  image,
  target,
  comment,
  onCommentChange,
  onSelect,
  onSave,
  onCancel,
}: {
  image: string;
  target: BrowserAnnotationTarget | null;
  comment: string;
  onCommentChange: (value: string) => void;
  onSelect: (rect: BrowserRect) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const surfaceRef = React.useRef<HTMLDivElement>(null);
  const originRef = React.useRef<{ x: number; y: number } | null>(null);
  const stopTrackingRef = React.useRef<(() => void) | null>(null);
  const [draftRect, setDraftRect] = React.useState<BrowserRect | null>(null);
  const [dragging, setDragging] = React.useState(false);
  const selection = draftRect ?? target?.boundingBox ?? null;
  const point = (clientX: number, clientY: number) => {
    const bounds = surfaceRef.current?.getBoundingClientRect();
    if (!bounds) return { x: 0, y: 0 };
    return {
      x: Math.min(Math.max(clientX - bounds.left, 0), bounds.width),
      y: Math.min(Math.max(clientY - bounds.top, 0), bounds.height),
    };
  };
  const rectangle = (start: { x: number; y: number }, end: { x: number; y: number }): BrowserRect => ({
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  });
  React.useEffect(() => () => stopTrackingRef.current?.(), []);

  return (
    <div className="absolute inset-0 z-10 overflow-hidden bg-dls-canvas" data-testid="browser-annotation-overlay" data-dragging={dragging}>
      <img src={image} alt="Frozen browser page for annotation" className="pointer-events-none absolute inset-0 h-full w-full" />
      <div
        ref={surfaceRef}
        className="absolute inset-0 cursor-crosshair select-none"
        onMouseDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          originRef.current = point(event.clientX, event.clientY);
          setDragging(true);
          setDraftRect(null);
          stopTrackingRef.current?.();
          const move = (moveEvent: MouseEvent) => {
            if (originRef.current) setDraftRect(rectangle(originRef.current, point(moveEvent.clientX, moveEvent.clientY)));
          };
          const up = (upEvent: MouseEvent) => {
            const start = originRef.current;
            originRef.current = null;
            setDragging(false);
            setDraftRect(null);
            stopTrackingRef.current?.();
            stopTrackingRef.current = null;
            if (start) onSelect(rectangle(start, point(upEvent.clientX, upEvent.clientY)));
          };
          window.addEventListener("mousemove", move);
          window.addEventListener("mouseup", up, { once: true });
          stopTrackingRef.current = () => {
            window.removeEventListener("mousemove", move);
            window.removeEventListener("mouseup", up);
          };
        }}
      />
      {selection ? (
        <div
          className="pointer-events-none absolute rounded-sm border-2 border-blue-500 bg-blue-500/15"
          style={{ left: selection.x, top: selection.y, width: Math.max(selection.width, 4), height: Math.max(selection.height, 4) }}
        />
      ) : null}
      {target && selection ? (
        <div
          className="absolute z-20 flex w-[min(340px,calc(100%-24px))] items-center gap-1.5 rounded-full border border-border bg-dls-canvas/95 p-1.5 shadow-xl backdrop-blur"
          style={{
            left: Math.max(12, Math.min(selection.x, (surfaceRef.current?.clientWidth ?? 360) - 352)),
            top: selection.y > 58 ? selection.y - 52 : selection.y + selection.height + 8,
          }}
          data-testid="browser-annotation-controls"
        >
          <MessageCircle className="ml-2 size-4 shrink-0 text-primary" />
          <Input aria-label="Annotation note" autoFocus placeholder="Add a comment…" value={comment} onChange={(event) => onCommentChange(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") onSave(); if (event.key === "Escape") onCancel(); }} className="h-8 min-w-0 flex-1 border-0 bg-transparent text-xs shadow-none focus-visible:ring-0" />
          <Button size="icon-sm" disabled={!comment.trim()} aria-label="Add annotation to task" onClick={onSave} className="shrink-0 rounded-full"><Check /></Button>
        </div>
      ) : null}
    </div>
  );
}

type BrowserResponsiveBarProps = {
  viewport: BrowserViewport;
  zoom: BrowserZoom;
  appliedScale: number | null;
  onViewportChange: (viewport: BrowserViewport) => void;
  onZoomChange: (zoom: BrowserZoom) => void;
  onClose: () => void;
};

function BrowserResponsiveBar({ viewport, zoom, appliedScale, onViewportChange, onZoomChange, onClose }: BrowserResponsiveBarProps) {
  const responsive = viewport.mode === "responsive";
  const [width, setWidth] = React.useState(responsive ? String(viewport.width) : "1440");
  const [height, setHeight] = React.useState(responsive ? String(viewport.height) : "900");
  React.useEffect(() => {
    setWidth(viewport.mode === "responsive" ? String(viewport.width) : "1440");
    setHeight(viewport.mode === "responsive" ? String(viewport.height) : "900");
  }, [viewport]);
  const commitDimensions = () => {
    const w = Number(width), h = Number(height);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w < 64 || h < 64) {
      setWidth(responsive ? String(viewport.width) : "1440");
      setHeight(responsive ? String(viewport.height) : "900");
      return;
    }
    onViewportChange(normalizeBrowserViewport({ mode: "responsive", width: w, height: h }));
  };
  const controlClass = "h-7 min-w-0 rounded-md border-0 bg-muted/60 px-2 text-xs text-foreground shadow-none focus-visible:outline focus-visible:outline-1 focus-visible:outline-ring";
  return (
    <div data-testid="browser-responsive-controls" className="flex h-10 shrink-0 items-center gap-2 border-b border-border/60 bg-dls-canvas px-2.5 text-xs text-muted-foreground">
      <span className="hidden shrink-0 @min-[600px]:inline">Dimensions:</span>
      <select aria-label="Viewport device" data-testid="browser-viewport-size-trigger" className={cn(controlClass, "w-40")} value={responsive ? browserViewportPresetId(viewport) ?? "custom" : "panel"} onChange={(event) => {
        if (event.target.value === "panel") { onViewportChange({ mode: "panel" }); return; }
        const preset = BROWSER_VIEWPORT_PRESETS.find((item) => item.id === event.target.value);
        onViewportChange({ mode: "responsive", width: preset?.width ?? Number(width), height: preset?.height ?? Number(height), deviceScaleFactor: 1 });
      }}>
        <option value="panel">Fit to panel</option>
        <option value="custom">Responsive</option>
        <optgroup label="Viewport presets">{BROWSER_VIEWPORT_PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}</optgroup>
      </select>
      <input aria-label="Viewport width" type="number" min={64} max={7680} value={width} onChange={(event) => setWidth(event.target.value)} onBlur={commitDimensions} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} className={cn(controlClass, "w-16 tabular-nums")} />
      <span aria-hidden="true">×</span>
      <input aria-label="Viewport height" type="number" min={64} max={7680} value={height} onChange={(event) => setHeight(event.target.value)} onBlur={commitDimensions} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} className={cn(controlClass, "w-16 tabular-nums")} />
      <Button variant="ghost" size="icon-sm" className="size-7 shrink-0" aria-label="Rotate viewport" disabled={!responsive} onClick={() => { if (responsive) onViewportChange({ ...viewport, width: viewport.height, height: viewport.width }); }}><RotateCw className="size-3.5" /></Button>
      <select aria-label="Viewport scale" className={cn(controlClass, "w-24")} value={zoom.mode === "fit" ? "fit" : zoom.mode === "actual" ? "1" : String(zoom.scale)} onChange={(event) => onZoomChange(event.target.value === "fit" ? { mode: "fit" } : { mode: "custom", scale: Number(event.target.value) })}>
        <option value="fit">Fit{appliedScale === null ? "" : ` · ${formatBrowserScalePercent(appliedScale)}`}</option>
        {BROWSER_ZOOM_STEPS.map((scale) => <option key={scale} value={scale}>{formatBrowserScalePercent(scale)}</option>)}
      </select>
      <Button variant="ghost" size="icon-sm" className="ml-auto size-6 shrink-0" aria-label="Close responsive controls" onClick={onClose}><X className="size-3.5" /></Button>
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
