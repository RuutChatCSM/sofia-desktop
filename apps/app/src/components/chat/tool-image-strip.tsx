"use client"

import * as React from "react"

import type { ToolImage } from "@/lib/tool-images"
import { cn } from "@/lib/utils"
import { ToolImageViewer } from "./tool-image-viewer"

type ToolImageStripProps = {
  images: ToolImage[]
  /** The run's images for ←/→; defaults to the thumbnails shown. */
  viewerImages?: ToolImage[]
  /** A run row shows only its newest screenshot. */
  latestOnly?: boolean
  /** Session that receives "Comment" annotations from the viewer. */
  sessionId?: string
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
 * ←/→ step through the run's images; the shared viewer owns Esc and zoom.
 */
export function ToolImageStrip({ images, viewerImages = images, latestOnly = false, sessionId, className }: ToolImageStripProps) {
  const [openIndex, setOpenIndex] = React.useState<number | null>(null)
  const visible = latestOnly ? images.slice(-1) : images.slice(0, MAX_VISIBLE)
  const overflow = latestOnly ? 0 : images.length - visible.length

  if (images.length === 0) return null

  const openAt = (imageIndex: number) => {
    setOpenIndex(viewerIndexFor(images, viewerImages, imageIndex))
  }

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

      <ToolImageViewer
        images={viewerImages}
        index={openIndex}
        onIndexChange={setOpenIndex}
        onClose={() => setOpenIndex(null)}
        sessionId={sessionId}
      />
    </>
  )
}
