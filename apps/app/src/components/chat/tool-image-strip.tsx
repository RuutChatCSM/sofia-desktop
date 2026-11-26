"use client"

import * as React from "react"
import { ChevronLeft, ChevronRight } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import type { ToolImage } from "@/lib/tool-images"
import { cn } from "@/lib/utils"

type ToolImageStripProps = {
  images: ToolImage[]
  /** The run's images for ←/→; defaults to the thumbnails shown. */
  viewerImages?: ToolImage[]
  /** A run row shows only its newest screenshot. */
  latestOnly?: boolean
  className?: string
}

const MAX_VISIBLE = 4

function viewerIndexFor(images: ToolImage[], viewerImages: ToolImage[], index: number): number {
  const src = images[index]?.src
  const match = src ? viewerImages.findIndex((image) => image.src === src) : -1
  return match >= 0 ? match : index
}

/**
 * Thumbnails for images a tool returned. Clicking opens one large viewer and
 * ←/→ step through the run's images; Esc closes (the Dialog owns that).
 */
export function ToolImageStrip({ images, viewerImages = images, latestOnly = false, className }: ToolImageStripProps) {
  const [openIndex, setOpenIndex] = React.useState<number | null>(null)
  const visible = latestOnly ? images.slice(-1) : images.slice(0, MAX_VISIBLE)
  const overflow = latestOnly ? 0 : images.length - visible.length

  React.useEffect(() => {
    if (openIndex === null) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "ArrowLeft") {
        event.preventDefault()
        event.stopPropagation()
        setOpenIndex((index) => (index === null ? index : Math.max(0, index - 1)))
      } else if (event.key === "ArrowRight") {
        event.preventDefault()
        event.stopPropagation()
        setOpenIndex((index) => (index === null ? index : Math.min(viewerImages.length - 1, index + 1)))
      } else if (event.key === "Escape") {
        event.preventDefault()
        event.stopPropagation()
        setOpenIndex(null)
      }
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [openIndex, viewerImages.length])

  if (images.length === 0) return null

  const openAt = (imageIndex: number) => {
    setOpenIndex(viewerIndexFor(images, viewerImages, imageIndex))
  }

  const current = openIndex === null ? null : viewerImages[openIndex]
  const hasPrevious = openIndex !== null && viewerImages.length > 1 && openIndex > 0
  const closeOnBackdrop = (event: React.MouseEvent<HTMLElement>) => {
    if (event.target === event.currentTarget) setOpenIndex(null)
  }
  const hasNext = openIndex !== null && viewerImages.length > 1 && openIndex < viewerImages.length - 1

  return (
    <>
      <div
        className={cn(
          "flex min-w-0 flex-wrap items-center",
          latestOnly ? "shrink-0" : "gap-1.5",
          className,
        )}
      >
        {visible.map((image, index) => {
          const actualIndex = latestOnly ? images.length - 1 : index
          return (
            <button
              key={`${image.src.slice(0, 64)}:${actualIndex}`}
              type="button"
              onClick={() => openAt(actualIndex)}
              aria-label={`Open image: ${image.alt}`}
              title={image.alt}
              className={cn(
                "cursor-zoom-in overflow-hidden rounded-md border border-border/70 bg-muted/40 transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 motion-reduce:transition-none",
                // Row-sized: the latest screenshot sits inline after the label
                // and never makes the row taller.
                latestOnly ? "h-5 w-8 rounded-sm" : "h-[120px]",
              )}
            >
              <img
                src={image.src}
                alt={image.alt}
                loading="lazy"
                decoding="async"
                className={cn(
                  "h-full w-full rounded-md",
                  latestOnly ? "object-cover" : "w-auto object-contain",
                )}
              />
            </button>
          )
        })}
        {overflow > 0 ? (
          <button
            type="button"
            onClick={() => openAt(MAX_VISIBLE)}
            aria-label={`Open ${overflow} more images`}
            className="flex h-[120px] min-w-12 cursor-zoom-in items-center justify-center rounded-md border border-border/70 bg-muted/40 px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 motion-reduce:transition-none"
          >
            +{overflow}
          </button>
        ) : null}
      </div>

      <Dialog
        open={openIndex !== null}
        onOpenChange={(open) => {
          if (!open) setOpenIndex(null)
        }}
      >
        {/* A full-window lightbox: the screenshot is the point, so it gets the
            room, and the controls sit beside and below it instead of on it. */}
        <DialogContent
          className={cn(
            // Override the dialog's card sizing at every breakpoint (it is a
            // centered max-w-md card on desktop and a bottom sheet below lg).
            "inset-0 flex h-dvh w-screen max-w-none flex-col gap-0 rounded-none bg-black/85 p-6 shadow-none ring-0 dark:ring-0",
            "lg:inset-0 lg:top-0 lg:inset-s-0 lg:h-dvh lg:w-screen lg:max-w-none lg:translate-x-0 lg:translate-y-0 lg:rounded-none rtl:lg:translate-x-0",
            "max-lg:top-0 max-lg:h-dvh max-lg:max-h-none max-lg:rounded-none max-lg:p-6",
          )}
          // The viewer covers the whole window, so its own dark area is the
          // "outside": a click there (not on the image or a control) closes it.
          onClick={closeOnBackdrop}
        >
          <DialogTitle className="sr-only">{current?.alt ?? "Tool image"}</DialogTitle>
          {current ? (
            <>
              <div onClick={closeOnBackdrop} className="flex min-h-0 flex-1 items-center justify-center gap-4 pt-12">
                {viewerImages.length > 1 ? (
                  <Button
                    type="button"
                    variant="secondary"
                    size="icon"
                    onClick={() => setOpenIndex((index) => (index === null ? index : Math.max(0, index - 1)))}
                    disabled={!hasPrevious}
                    aria-label="Previous image"
                    className="shrink-0 rounded-full bg-background/85 backdrop-blur"
                  >
                    <ChevronLeft aria-hidden="true" />
                  </Button>
                ) : null}
                <img
                  src={current.src}
                  alt={current.alt}
                  className="max-h-full min-w-0 max-w-full rounded-xl object-contain shadow-2xl"
                />
                {viewerImages.length > 1 ? (
                  <Button
                    type="button"
                    variant="secondary"
                    size="icon"
                    onClick={() => setOpenIndex((index) => (index === null ? index : Math.min(viewerImages.length - 1, index + 1)))}
                    disabled={!hasNext}
                    aria-label="Next image"
                    className="shrink-0 rounded-full bg-background/85 backdrop-blur"
                  >
                    <ChevronRight aria-hidden="true" />
                  </Button>
                ) : null}
              </div>
              <div onClick={closeOnBackdrop} className="mt-3 flex shrink-0 items-center justify-center gap-2 text-xs text-white/75">
                <span className="max-w-[60vw] truncate">{current.alt}</span>
                {viewerImages.length > 1 ? (
                  <span className="tabular-nums text-white/55">· {(openIndex ?? 0) + 1} / {viewerImages.length}</span>
                ) : null}
              </div>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  )
}
