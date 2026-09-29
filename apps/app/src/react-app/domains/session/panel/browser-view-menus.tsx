/** @jsxImportSource react */
// The browser view's viewport and zoom pickers.
//
// They are in-place palettes rather than popups on purpose. The page is a
// native `WebContentsView` painted above this DOM, so a floating menu would be
// hidden behind it — and the only way to show a popup would be to detach the
// page, which blanks the browser while the menu is open. A palette owns a row
// above the canvas instead, so the page stays visible and the canvas simply
// resizes for as long as the palette is open.
import * as React from "react";
import { Check, ChevronDown, Monitor } from "lucide-react";

import {
  BROWSER_VIEWPORT_PRESETS,
  BROWSER_ZOOM_STEPS,
  browserViewportPresetId,
  browserZoomLabel,
  formatBrowserScalePercent,
  normalizeBrowserViewport,
  type BrowserToolbarDensity,
} from "@/app/lib/browser-tab-state";
import type { BrowserViewport, BrowserZoom } from "@/app/lib/desktop-types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/** Which browser control palette the panel chrome currently has open. */
export type BrowserPalette = "viewport" | "zoom" | null;

type TriggerProps = {
  open: boolean;
  onToggle: () => void;
};

type ViewportTriggerProps = TriggerProps & {
  viewport: BrowserViewport;
  density: BrowserToolbarDensity;
};

/** Toolbar control that reveals the viewport palette. */
export function BrowserViewportTrigger({ viewport, density, open, onToggle }: ViewportTriggerProps) {
  const responsive = viewport.mode === "responsive";
  const label = responsive
    ? (density === "full" ? `${viewport.width} × ${viewport.height}` : `${viewport.width}×${viewport.height}`)
    : "Panel";

  return (
    <Button
      variant="ghost"
      size="sm"
      aria-label="Viewport"
      aria-expanded={open}
      data-testid="browser-viewport-trigger"
      onClick={onToggle}
      className={cn(
        "h-6 shrink-0 gap-1 px-2 text-[11px] font-normal text-muted-foreground tabular-nums",
        open && "bg-foreground/10 text-foreground",
      )}
    >
      {density === "essential" ? <Monitor className="size-3.5" /> : <span>{label}</span>}
      <ChevronDown className={cn("size-3 transition-transform", open && "rotate-180")} />
    </Button>
  );
}

type ZoomTriggerProps = TriggerProps & {
  zoom: BrowserZoom;
  appliedScale: number | null;
  density: BrowserToolbarDensity;
};

/** Responsive-row control that reveals the zoom palette. */
export function BrowserZoomTrigger({ zoom, appliedScale, density, open, onToggle }: ZoomTriggerProps) {
  const label = browserZoomLabel(zoom, appliedScale);
  const triggerLabel = density === "full"
    ? label
    : density === "compact"
      ? label.replace(" · ", " ")
      : (zoom.mode === "fit" && typeof appliedScale === "number" ? formatBrowserScalePercent(appliedScale) : label);

  return (
    <Button
      variant="ghost"
      size="sm"
      aria-label="Zoom"
      aria-expanded={open}
      data-testid="browser-zoom-trigger"
      onClick={onToggle}
      className={cn(
        "h-6 shrink-0 gap-1 px-2 text-[11px] font-normal text-muted-foreground tabular-nums",
        open && "bg-foreground/10 text-foreground",
      )}
    >
      {triggerLabel}
      <ChevronDown className={cn("size-3 transition-transform", open && "rotate-180")} />
    </Button>
  );
}

type PaletteButtonProps = {
  testId: string;
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
};

function PaletteButton({ testId, selected, onClick, children }: PaletteButtonProps) {
  return (
    <Button
      variant="ghost"
      size="sm"
      data-testid={testId}
      onClick={onClick}
      className={cn(
        "h-6 gap-1 rounded-md px-2 text-[11px] font-normal",
        selected ? "bg-foreground/5 ring-1 ring-inset ring-border text-foreground" : "text-muted-foreground hover:bg-foreground/5",
      )}
    >
      {selected ? <Check className="size-3" /> : null}
      {children}
    </Button>
  );
}

type BrowserViewportPaletteProps = {
  viewport: BrowserViewport;
  onSelect: (viewport: BrowserViewport) => void;
};

export function BrowserViewportPalette({ viewport, onSelect }: BrowserViewportPaletteProps) {
  const presetId = browserViewportPresetId(viewport);
  const responsive = viewport.mode === "responsive";
  const [customOpen, setCustomOpen] = React.useState(responsive && presetId === null);
  const [width, setWidth] = React.useState(responsive ? String(viewport.width) : "1440");
  const [height, setHeight] = React.useState(responsive ? String(viewport.height) : "900");

  React.useEffect(() => {
    setWidth(viewport.mode === "responsive" ? String(viewport.width) : "1440");
    setHeight(viewport.mode === "responsive" ? String(viewport.height) : "900");
  }, [viewport]);

  return (
    <div
      data-testid="browser-viewport-palette"
      className="shrink-0 border-b border-border/60 bg-muted/30 px-2 py-1.5"
    >
      <div className="flex flex-wrap items-center gap-1">
        <span className="pe-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">Viewport</span>
        <PaletteButton
          testId="browser-viewport-option-panel"
          selected={viewport.mode === "panel"}
          onClick={() => onSelect({ mode: "panel" })}
        >
          Panel
        </PaletteButton>
        <span aria-hidden="true" className="mx-1 h-4 border-l border-border" />
        {BROWSER_VIEWPORT_PRESETS.map((preset) => (
          <PaletteButton
            key={preset.id}
            testId={`browser-viewport-option-${preset.id}`}
            selected={presetId === preset.id}
            onClick={() => onSelect({
              mode: "responsive",
              width: preset.width,
              height: preset.height,
              deviceScaleFactor: 1,
            })}
          >
            {preset.label}
            <span className="text-muted-foreground tabular-nums">{preset.width}×{preset.height}</span>
          </PaletteButton>
        ))}
        <PaletteButton
          testId="browser-viewport-option-custom"
          selected={responsive && presetId === null}
          onClick={() => setCustomOpen(true)}
        >
          Custom…
        </PaletteButton>
      </div>
      {customOpen ? (
        <div className="mt-1.5 flex items-center gap-1.5">
          <Input
            data-testid="browser-viewport-width"
            aria-label="Viewport width"
            inputMode="numeric"
            className="h-6 w-20 text-[11px]"
            value={width}
            onChange={(event) => setWidth(event.target.value)}
          />
          <span className="text-[11px] text-muted-foreground">×</span>
          <Input
            data-testid="browser-viewport-height"
            aria-label="Viewport height"
            inputMode="numeric"
            className="h-6 w-20 text-[11px]"
            value={height}
            onChange={(event) => setHeight(event.target.value)}
          />
          <Button
            variant="ghost"
            size="sm"
            data-testid="browser-viewport-swap"
            className="h-6 px-2 text-[11px]"
            onClick={() => { setWidth(height); setHeight(width); }}
          >
            Swap
          </Button>
          <Button
            size="sm"
            data-testid="browser-viewport-apply"
            className="h-6 px-2 text-[11px]"
            onClick={() => onSelect(normalizeBrowserViewport({
              mode: "responsive",
              width: Number(width),
              height: Number(height),
              deviceScaleFactor: 1,
            }))}
          >
            Apply
          </Button>
        </div>
      ) : null}
    </div>
  );
}

type BrowserZoomPaletteProps = {
  zoom: BrowserZoom;
  appliedScale: number | null;
  onSelect: (zoom: BrowserZoom) => void;
};

export function BrowserZoomPalette({ zoom, appliedScale, onSelect }: BrowserZoomPaletteProps) {
  return (
    <div data-testid="browser-zoom-palette" className="shrink-0 border-b border-border/60 bg-muted/30 px-2 py-1.5">
      <div className="flex flex-wrap items-center gap-1">
        <span className="pe-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">Zoom</span>
        <PaletteButton testId="browser-zoom-option-fit" selected={zoom.mode === "fit"} onClick={() => onSelect({ mode: "fit" })}>
          Fit
          {typeof appliedScale === "number" ? (
            <span className="text-muted-foreground tabular-nums">{formatBrowserScalePercent(appliedScale)}</span>
          ) : null}
        </PaletteButton>
        <PaletteButton testId="browser-zoom-option-actual" selected={zoom.mode === "actual"} onClick={() => onSelect({ mode: "actual" })}>
          Actual size
          <span className="text-muted-foreground tabular-nums">100%</span>
        </PaletteButton>
        {BROWSER_ZOOM_STEPS.map((step) => (
          <PaletteButton
            key={step}
            testId={`browser-zoom-option-${Math.round(step * 100)}`}
            selected={zoom.mode === "custom" && zoom.scale === step}
            onClick={() => onSelect({ mode: "custom", scale: step })}
          >
            <span className="tabular-nums">{formatBrowserScalePercent(step)}</span>
          </PaletteButton>
        ))}
      </div>
    </div>
  );
}
