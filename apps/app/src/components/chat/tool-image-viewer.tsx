"use client"

import * as React from "react"
import { ChevronLeft, ChevronRight, Copy, Download, ExternalLink, MessageSquarePlus, X } from "lucide-react"

import { openDesktopUrl } from "@/app/lib/desktop"
import { isElectronRuntime } from "@/app/lib/runtime-env"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import {
  buildScreenshotAnnotationAttachment,
  downloadNameForToolImage,
  fitToolImageZoom,
  toolImageZoomAfterWheel,
  toolImageZoomPercent,
  type ToolImageSize,
} from "@/lib/tool-image-gallery"
import type { ToolImage } from "@/lib/tool-images"
import { cn } from "@/lib/utils"
import { ToolImageAnnotator } from "./tool-image-annotator"

type ToolImageViewerProps = {
  images: ToolImage[]
  /** `null` keeps the viewer closed; otherwise it is the image to show. */
  index: number | null
  onIndexChange: (index: number) => void
  onClose: () => void
  /** Enables "Comment"; the annotation event is routed to this session. */
  sessionId?: string
}

type ZoomMode = "fit" | "actual" | "custom"
type Pan = { x: number; y: number }
type DragState = { pointerId: number; startX: number; startY: number; originX: number; originY: number }
type CopyState = "idle" | "copied" | "text" | "failed"

async function pngBlobForImage(src: string): Promise<Blob> {
  const response = await fetch(src)
  const blob = await response.blob()
  if (blob.type === "image/png") return blob
  const bitmap = await createImageBitmap(blob)
  const canvas = document.createElement("canvas")
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  const context = canvas.getContext("2d")
  if (!context) {
    bitmap.close()
    throw new Error("Canvas is unavailable")
  }
  context.drawImage(bitmap, 0, 0)
  bitmap.close()
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((png) => {
      if (png) resolve(png)
      else reject(new Error("Could not encode the image as PNG"))
    }, "image/png")
  })
}

/**
 * Full-window image viewer shared by the thumbnail strip, the turn gallery and
 * the side panel. It owns Fit/100%/custom zoom, panning, copying, downloading
 * and the screenshot annotation flow.
 */
export function ToolImageViewer({ images, index, onIndexChange, onClose, sessionId }: ToolImageViewerProps) {
  const current = index === null ? null : images[index] ?? null
  const open = current !== null
  const [zoom, setZoom] = React.useState(1)
  const [fitZoom, setFitZoom] = React.useState(1)
  const [zoomMode, setZoomMode] = React.useState<ZoomMode>("fit")
  const [pan, setPan] = React.useState<Pan>({ x: 0, y: 0 })
  const [naturalSize, setNaturalSize] = React.useState<ToolImageSize | null>(null)
  const [annotating, setAnnotating] = React.useState(false)
  const [copyState, setCopyState] = React.useState<CopyState>("idle")
  const [notice, setNotice] = React.useState<string | null>(null)
  const viewportRef = React.useRef<HTMLDivElement | null>(null)
  const dragRef = React.useRef<DragState | null>(null)
  const movedRef = React.useRef(false)
  const pressedBackdropRef = React.useRef(false)
  const currentSrc = current?.src ?? null

  React.useEffect(() => {
    setZoom(1)
    setFitZoom(1)
    setZoomMode("fit")
    setPan({ x: 0, y: 0 })
    setNaturalSize(null)
    setAnnotating(false)
    setCopyState("idle")
  }, [currentSrc])

  React.useEffect(() => {
    if (!open) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault()
        event.stopPropagation()
        if (annotating) setAnnotating(false)
        else onClose()
        return
      }
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
      if (annotating) return
      const target = event.target
      const editing = target instanceof HTMLElement
        && (target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT")
      if (editing) return
      event.preventDefault()
      event.stopPropagation()
      const step = event.key === "ArrowLeft" ? -1 : 1
      const next = Math.min(images.length - 1, Math.max(0, (index ?? 0) + step))
      if (next !== index) onIndexChange(next)
    }
    window.addEventListener("keydown", handleKeyDown, true)
    return () => window.removeEventListener("keydown", handleKeyDown, true)
  }, [open, annotating, images.length, index, onClose, onIndexChange])

  React.useEffect(() => {
    if (!open || annotating || !naturalSize) return
    const update = () => {
      const viewport = viewportRef.current
      if (!viewport) return
      const nextFit = fitToolImageZoom(naturalSize, {
        width: viewport.clientWidth,
        height: viewport.clientHeight,
      })
      setFitZoom(nextFit)
      if (zoomMode === "fit") setZoom(nextFit)
    }
    update()
    const observer = new ResizeObserver(update)
    if (viewportRef.current) observer.observe(viewportRef.current)
    window.addEventListener("resize", update)
    return () => {
      observer.disconnect()
      window.removeEventListener("resize", update)
    }
  }, [open, annotating, naturalSize, zoomMode])

  React.useEffect(() => {
    if (!open || annotating) return
    const viewport = viewportRef.current
    if (!viewport) return
    const handleWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      setZoomMode("custom")
      setZoom((value) => toolImageZoomAfterWheel(value, event.deltaY))
    }
    viewport.addEventListener("wheel", handleWheel, { passive: false })
    return () => viewport.removeEventListener("wheel", handleWheel)
  }, [open, annotating])

  if (!current) {
    return (
      <Dialog open={false} onOpenChange={() => undefined}>
        <DialogContent className="hidden" />
      </Dialog>
    )
  }

  const closeOnBackdrop = (event: React.MouseEvent<HTMLElement>) => {
    if (event.target === event.currentTarget) onClose()
  }

  const canPan = zoom > fitZoom + 0.001
  const canOpenExternally = isElectronRuntime() && /^https?:\/\//i.test(current.src)
  const hasPrevious = images.length > 1 && index !== null && index > 0
  const hasNext = images.length > 1 && index !== null && index < images.length - 1

  const showFit = () => {
    setZoomMode("fit")
    setZoom(fitZoom)
    setPan({ x: 0, y: 0 })
  }

  const showActualSize = () => {
    setZoomMode("actual")
    setZoom(1)
    setPan({ x: 0, y: 0 })
  }

  const handleCopy = async () => {
    try {
      const png = await pngBlobForImage(current.src)
      if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) throw new Error("Clipboard is unavailable")
      await navigator.clipboard.write([new ClipboardItem({ "image/png": png })])
      setCopyState("copied")
    } catch {
      try {
        await navigator.clipboard.writeText(current.src)
        setCopyState("text")
      } catch {
        setCopyState("failed")
      }
    }
    window.setTimeout(() => setCopyState("idle"), 2500)
  }

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    pressedBackdropRef.current = event.target === event.currentTarget
    if (!canPan) return
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: pan.x,
      originY: pan.y,
    }
    movedRef.current = false
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const dx = event.clientX - drag.startX
    const dy = event.clientY - drag.startY
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) movedRef.current = true
    setPan({ x: drag.originX + dx, y: drag.originY + dy })
  }

  const finishPointer = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    dragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const handleViewportClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (annotating) return
    if (event.target !== event.currentTarget) return
    if (!pressedBackdropRef.current) return
    pressedBackdropRef.current = false
    if (movedRef.current) {
      movedRef.current = false
      return
    }
    onClose()
  }

  const handleAnnotate = (note: string, dataUrl: string) => {
    if (!sessionId) return
    const attachment = buildScreenshotAnnotationAttachment({ alt: current.alt, note, imageDataUrl: dataUrl })
    if (!attachment) return
    window.dispatchEvent(new CustomEvent("sofia:browser-annotation", {
      detail: { sessionId, text: attachment.annotationContext, image: attachment.imageDataUrl },
    }))
    setAnnotating(false)
    setNotice("Annotation added to your message")
    window.setTimeout(() => setNotice(null), 3000)
  }

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onClose() }}>
      {/* A full-window lightbox: the screenshot is the point, so it gets the
          room, and the controls sit beside and below it instead of on it. */}
      <DialogContent
        showCloseButton={false}
        className={cn(
          // Override the dialog's card sizing at every breakpoint (it is a
          // centered max-w-md card on desktop and a bottom sheet below lg).
          "inset-0 flex h-dvh w-screen max-w-none flex-col gap-0 rounded-none bg-black/85 p-4 shadow-none ring-0 dark:ring-0 sm:p-6",
          "lg:inset-0 lg:top-0 lg:inset-s-0 lg:h-dvh lg:w-screen lg:max-w-none lg:translate-x-0 lg:translate-y-0 lg:rounded-none rtl:lg:translate-x-0",
          "max-lg:top-0 max-lg:h-dvh max-lg:max-h-none max-lg:rounded-none max-lg:p-4",
        )}
        // The viewer covers the whole window, so its own dark area is the
        // "outside": a click there (not on the image or a control) closes it.
        onClick={closeOnBackdrop}
      >
        <DialogTitle className="sr-only">{current.alt}</DialogTitle>
        <div onClick={closeOnBackdrop} className="flex shrink-0 flex-wrap items-center gap-2 pb-3">
          <div className="me-auto min-w-0 max-w-full">
            <p className="truncate text-sm text-white/85">{current.alt}</p>
            {notice ? <p className="text-xs text-white/60">{notice}</p> : null}
          </div>
          <div className="flex items-center gap-0.5 rounded-full bg-background/85 p-0.5 backdrop-blur">
            <Button
              type="button"
              size="xs"
              variant={zoomMode === "fit" ? "secondary" : "ghost"}
              aria-pressed={zoomMode === "fit"}
              onClick={showFit}
            >
              Fit
            </Button>
            <Button
              type="button"
              size="xs"
              variant={zoomMode === "actual" ? "secondary" : "ghost"}
              aria-pressed={zoomMode === "actual"}
              onClick={showActualSize}
            >
              100%
            </Button>
            <span className="w-10 text-center text-xs tabular-nums text-foreground" aria-live="polite">
              {toolImageZoomPercent(zoom)}%
            </span>
          </div>
          <Button type="button" size="sm" variant="secondary" onClick={() => void handleCopy()} aria-label="Copy image">
            <Copy aria-hidden="true" />
            <span className="hidden sm:inline">
              {copyState === "copied" ? "Copied" : copyState === "text" ? "Copied link" : copyState === "failed" ? "Copy failed" : "Copy"}
            </span>
          </Button>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            render={<a href={current.src} download={downloadNameForToolImage(current)} />}
            aria-label="Download image"
          >
            <Download aria-hidden="true" />
            <span className="hidden sm:inline">Download</span>
          </Button>
          {canOpenExternally ? (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => void openDesktopUrl(current.src).catch(() => undefined)}
            >
              <ExternalLink aria-hidden="true" />
              <span className="hidden sm:inline">Open</span>
            </Button>
          ) : null}
          {sessionId ? (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              aria-pressed={annotating}
              onClick={() => setAnnotating((value) => !value)}
            >
              <MessageSquarePlus aria-hidden="true" />
              <span className="hidden sm:inline">Comment</span>
            </Button>
          ) : null}
          <Button type="button" size="icon-sm" variant="secondary" aria-label="Close image viewer" onClick={onClose}>
            <X aria-hidden="true" />
          </Button>
        </div>

        <div onClick={closeOnBackdrop} className="flex min-h-0 flex-1 items-stretch gap-2 sm:gap-4">
          {images.length > 1 ? (
            <div className="flex min-h-0 w-20 shrink-0 flex-col gap-2 overflow-y-auto pe-1 py-1" aria-label="Screenshots">
              {images.map((image, imageIndex) => (
                <button
                  key={`${image.src.slice(0, 48)}:${imageIndex}`}
                  type="button"
                  onClick={() => onIndexChange(imageIndex)}
                  aria-label={`Show image: ${image.alt}`}
                  aria-current={imageIndex === index}
                  className={cn(
                    "h-11 w-16 shrink-0 cursor-pointer overflow-hidden rounded-md border border-white/10 bg-white/5 transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 motion-reduce:transition-none",
                    imageIndex === index && "ring-2 ring-primary",
                  )}
                >
                  <img
                    src={image.src}
                    alt={image.alt}
                    loading="lazy"
                    decoding="async"
                    className="h-full w-full object-cover"
                  />
                </button>
              ))}
            </div>
          ) : null}

          {images.length > 1 ? (
            <Button
              type="button"
              variant="secondary"
              size="icon"
              onClick={() => onIndexChange(Math.max(0, (index ?? 0) - 1))}
              disabled={!hasPrevious}
              aria-label="Previous image"
              className="shrink-0 self-center rounded-full bg-background/85 backdrop-blur"
            >
              <ChevronLeft aria-hidden="true" />
            </Button>
          ) : null}

          <div
            ref={viewportRef}
            onClick={handleViewportClick}
            onPointerDown={annotating ? undefined : handlePointerDown}
            onPointerMove={annotating ? undefined : handlePointerMove}
            onPointerUp={annotating ? undefined : finishPointer}
            onPointerCancel={annotating ? undefined : finishPointer}
            className={cn(
              "relative flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden rounded-xl",
              !annotating && canPan && "cursor-grab touch-none active:cursor-grabbing",
            )}
          >
            {annotating ? (
              <ToolImageAnnotator
                image={current}
                onCancel={() => setAnnotating(false)}
                onSubmit={handleAnnotate}
              />
            ) : (
              <img
                src={current.src}
                alt={current.alt}
                draggable={false}
                decoding="async"
                onLoad={(event) => setNaturalSize({
                  width: event.currentTarget.naturalWidth,
                  height: event.currentTarget.naturalHeight,
                })}
                style={naturalSize ? {
                  width: naturalSize.width * zoom,
                  height: naturalSize.height * zoom,
                  maxWidth: "none",
                  maxHeight: "none",
                  transform: `translate3d(${pan.x}px, ${pan.y}px, 0)`,
                } : undefined}
                className={cn(
                  "rounded-xl object-contain shadow-2xl select-none",
                  !naturalSize && "max-h-full max-w-full",
                  canPan ? "cursor-grab active:cursor-grabbing" : "cursor-zoom-in",
                )}
              />
            )}
          </div>

          {images.length > 1 ? (
            <Button
              type="button"
              variant="secondary"
              size="icon"
              onClick={() => onIndexChange(Math.min(images.length - 1, (index ?? 0) + 1))}
              disabled={!hasNext}
              aria-label="Next image"
              className="shrink-0 self-center rounded-full bg-background/85 backdrop-blur"
            >
              <ChevronRight aria-hidden="true" />
            </Button>
          ) : null}
        </div>

        <div onClick={closeOnBackdrop} className="mt-3 flex shrink-0 items-center justify-center gap-2 text-xs text-white/75">
          <span className="max-w-[60vw] truncate">{current.alt}</span>
          {images.length > 1 ? (
            <span className="tabular-nums text-white/55">· {(index ?? 0) + 1} / {images.length}</span>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}
