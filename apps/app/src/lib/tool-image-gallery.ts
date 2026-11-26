import type { ToolImage } from "./tool-images"

export const TOOL_IMAGE_MIN_ZOOM = 0.1
export const TOOL_IMAGE_MAX_ZOOM = 4

export type ToolImageSize = {
  width: number
  height: number
}

/** The answer gallery starts on the newest screenshot of the turn. */
export function latestToolImageIndex(count: number): number {
  return Math.max(0, count - 1)
}

/** Keep a selection valid after images arrive or the turn shrinks. */
export function toolImageGallerySelection(index: number, images: ToolImage[]): number {
  if (images.length === 0) return 0
  return Math.min(Math.max(index, 0), images.length - 1)
}

export function clampToolImageZoom(zoom: number): number {
  return Math.min(TOOL_IMAGE_MAX_ZOOM, Math.max(TOOL_IMAGE_MIN_ZOOM, zoom))
}

export function toolImageZoomPercent(zoom: number): number {
  return Math.round(clampToolImageZoom(zoom) * 100)
}

/** Fit never enlarges a small screenshot past its natural size. */
export function fitToolImageZoom(image: ToolImageSize, viewport: ToolImageSize): number {
  if (image.width <= 0 || image.height <= 0 || viewport.width <= 0 || viewport.height <= 0) return 1
  return clampToolImageZoom(Math.min(1, viewport.width / image.width, viewport.height / image.height))
}

/** Ctrl/Cmd + wheel: a negative delta (wheel up) zooms in. */
export function toolImageZoomAfterWheel(zoom: number, deltaY: number): number {
  return clampToolImageZoom(zoom * Math.exp(-deltaY * 0.0015))
}

export function downloadNameForToolImage(image: ToolImage): string {
  const base = image.alt.trim().replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "")
  const extension = (image.mediaType.split("/")[1] ?? "png").split("+")[0]
  const name = base || "image"
  return name.includes(".") ? name : `${name}.${extension}`
}

export type ScreenshotAnnotationAttachment = {
  annotationContext: string
  imageDataUrl: string
  mediaType: string
}

const DATA_IMAGE_PATTERN = /^data:(image\/[a-z0-9.+-]+);base64,/i

/**
 * The annotated screenshot rides the same composer event as a browser
 * annotation: `annotationContext` becomes an `application/x-sofia-annotation`
 * part and the PNG becomes the image part beside it.
 */
export function buildScreenshotAnnotationAttachment(input: {
  alt: string
  note: string
  imageDataUrl: string
}): ScreenshotAnnotationAttachment | null {
  const note = input.note.trim()
  const match = DATA_IMAGE_PATTERN.exec(input.imageDataUrl)
  if (!note || !match) return null
  const name = input.alt.trim() || "screenshot"
  return {
    annotationContext: `On the screenshot "${name}", the user annotated. ${note}`,
    imageDataUrl: input.imageDataUrl,
    mediaType: match[1],
  }
}
