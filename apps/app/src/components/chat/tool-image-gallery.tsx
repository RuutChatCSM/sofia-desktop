"use client"

import * as React from "react"

import type { ToolImage } from "@/lib/tool-images"
import { latestToolImageIndex, toolImageGallerySelection } from "@/lib/tool-image-gallery"
import { cn } from "@/lib/utils"
import { ToolImageViewer } from "./tool-image-viewer"

type ToolImageGalleryProps = {
  images: ToolImage[]
  /** Session that receives "Comment" annotations from the viewer. */
  sessionId?: string
  className?: string
}

/**
 * The answer's screenshots: one large selected image, with a scrollable rail
 * when the turn produced more. Clicking a rail thumbnail swaps the hero; the
 * hero opens the full viewer at the selected image.
 */
export function ToolImageGallery({ images, sessionId, className }: ToolImageGalleryProps) {
  const [selected, setSelected] = React.useState(() => latestToolImageIndex(images.length))
  const [viewerIndex, setViewerIndex] = React.useState<number | null>(null)
  const lastSrc = images[images.length - 1]?.src ?? ""

  React.useEffect(() => {
    setSelected(latestToolImageIndex(images.length))
  }, [images.length, lastSrc])

  const activeIndex = toolImageGallerySelection(selected, images)
  const active = images[activeIndex]
  if (!active) return null

  return (
    <>
      <div className={cn("flex w-full max-w-[640px] flex-col gap-2 sm:flex-row sm:items-start", className)}>
        <button
          type="button"
          onClick={() => setViewerIndex(activeIndex)}
          aria-label={`Open image: ${active.alt}`}
          title={active.alt}
          className="block w-full min-w-0 max-w-[560px] flex-1 cursor-zoom-in overflow-hidden rounded-xl border border-border/60 bg-muted/30 transition-opacity hover:opacity-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 motion-reduce:transition-none"
        >
          <img
            src={active.src}
            alt={active.alt}
            loading="lazy"
            decoding="async"
            className="max-h-[420px] w-full rounded-xl object-contain"
          />
        </button>
        {images.length > 1 ? (
          <div
            role="group"
            aria-label="Screenshots"
            className="flex shrink-0 gap-1.5 overflow-x-auto pb-1 sm:w-16 sm:max-h-[420px] sm:flex-col sm:overflow-x-hidden sm:overflow-y-auto sm:pb-0 sm:pe-1"
          >
            {images.map((image, index) => (
              <button
                key={`${image.src.slice(0, 48)}:${index}`}
                type="button"
                onClick={() => setSelected(index)}
                aria-label={`Show image: ${image.alt}`}
                aria-current={index === activeIndex}
                className={cn(
                  "h-11 w-16 shrink-0 cursor-pointer overflow-hidden rounded-md border border-border/60 bg-muted/30 transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 motion-reduce:transition-none",
                  index === activeIndex && "ring-2 ring-ring ring-offset-1 ring-offset-background",
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
      </div>
      <ToolImageViewer
        images={images}
        index={viewerIndex}
        onIndexChange={setViewerIndex}
        onClose={() => setViewerIndex(null)}
        sessionId={sessionId}
      />
    </>
  )
}
