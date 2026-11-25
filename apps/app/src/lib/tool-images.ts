/**
 * Tool results can carry images — browser/computer-use screenshots, MCP
 * `content: [{ type: "image", data, mimeType }]`, and codex `input_image` /
 * `image_url` entries. They arrive as data URLs, base64 + mime type, or http
 * URLs, sometimes nested in a JSON string. Never render that raw: extract it
 * for a thumbnail strip and replace it with a short placeholder in text.
 */
export type ToolImage = {
  src: string
  mediaType: string
  alt: string
}

type JsonRecord = Record<string, unknown>

const IMAGE_MEDIA_TYPE_PATTERN = /^image\/[a-z0-9.+-]+$/i
const DATA_IMAGE_PATTERN = /data:(image\/[a-z0-9.+-]+);base64,[a-z0-9+/=]+/gi
const IMAGE_URL_PATTERN = /^https?:\/\/[^\s]+\.(?:png|jpe?g|gif|webp|avif|svg)(?:[?#][^\s]*)?$/i
const IMAGE_KEYS = ["output", "content", "contentItems", "result", "parts", "items", "details", "sofia", "mcpResult", "data"] as const
const MAX_DEPTH = 8
const MAX_IMAGES = 32

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readString(record: JsonRecord, key: string): string {
  const value = record[key]
  return typeof value === "string" ? value.trim() : ""
}

function mediaTypeFromDataUrl(src: string): string {
  const match = /^data:(image\/[a-z0-9.+-]+)(?:[;,]|$)/i.exec(src)
  return match?.[1] ?? "image/png"
}

function mediaTypeFromExtension(src: string): string {
  const clean = src.split(/[?#]/)[0] ?? src
  const extension = clean.split(".").pop()?.toLowerCase() ?? ""
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg"
  if (extension === "svg") return "image/svg+xml"
  if (["png", "gif", "webp", "avif"].includes(extension)) return `image/${extension}`
  return "image/png"
}

function extensionForMediaType(mediaType: string): string {
  if (mediaType === "image/jpeg") return "jpg"
  if (mediaType === "image/svg+xml") return "svg"
  return mediaType.split("/")[1] ?? "png"
}

function imageName(record: JsonRecord, src: string, index: number): string {
  const explicit = readString(record, "filename") || readString(record, "name") || readString(record, "alt") || readString(record, "title")
  if (explicit) return explicit
  if (!src.startsWith("data:")) {
    const clean = src.split(/[?#]/)[0] ?? src
    const name = clean.split("/").filter(Boolean).pop()
    if (name) return name
  }
  return `screenshot-${index}.${extensionForMediaType(mediaTypeFromDataUrl(src))}`
}

function isImageRecord(record: JsonRecord): boolean {
  const type = readString(record, "type").toLowerCase()
  return ["image", "input_image", "input-image", "output_image", "output-image", "image_url"].includes(type)
}

function srcFromRecord(record: JsonRecord): string {
  const direct = record.url ?? record.image_url ?? record.src ?? record.imageUrl
  if (typeof direct === "string" && direct.trim()) return direct.trim()
  if (isRecord(direct)) {
    const nested = readString(direct, "url")
    if (nested) return nested
  }
  if (isRecord(record.source)) {
    const nested = readString(record.source, "url")
    if (nested) return nested
  }
  return ""
}

function mimeFromRecord(record: JsonRecord): string {
  const explicit = readString(record, "mimeType") || readString(record, "mediaType") || readString(record, "media_type") || readString(record, "mime_type")
  if (IMAGE_MEDIA_TYPE_PATTERN.test(explicit)) return explicit
  if (isRecord(record.source)) {
    const nested = readString(record.source, "media_type") || readString(record.source, "mimeType")
    if (IMAGE_MEDIA_TYPE_PATTERN.test(nested)) return nested
  }
  return ""
}

/** `{ type: "image", data, mimeType }` or an image-url shaped entry. */
function imageFromRecord(record: JsonRecord, index: number): ToolImage | null {
  const mediaTypeField = mimeFromRecord(record)
  let data = readString(record, "data")
  if (!data && isRecord(record.source)) data = readString(record.source, "data")

  let src = srcFromRecord(record)
  if (!src && data && mediaTypeField) src = `data:${mediaTypeField};base64,${data}`
  if (!src) return null

  const mediaType = DATA_IMAGE_PATTERN.test(src)
    ? mediaTypeFromDataUrl(src)
    : mediaTypeField || mediaTypeFromExtension(src)
  DATA_IMAGE_PATTERN.lastIndex = 0
  if (!IMAGE_MEDIA_TYPE_PATTERN.test(mediaType)) return null

  // A bare `{ url }` is how MCP link results arrive too; only an image-typed
  // record, an explicit image_url field, or an image file extension is one.
  const explicitImageField = record.image_url !== undefined || record.imageUrl !== undefined
  const looksLikeImage = isImageRecord(record) || src.startsWith("data:image/") || explicitImageField || IMAGE_URL_PATTERN.test(src)
  if (!looksLikeImage) return null

  return { src, mediaType, alt: imageName(record, src, index) }
}

function collectDataUrls(value: string, images: ToolImage[], seen: Set<string>) {
  DATA_IMAGE_PATTERN.lastIndex = 0
  for (const match of value.matchAll(DATA_IMAGE_PATTERN)) {
    const src = match[0]
    if (seen.has(src)) continue
    seen.add(src)
    images.push({ src, mediaType: mediaTypeFromDataUrl(src), alt: imageName({}, src, images.length + 1) })
    if (images.length >= MAX_IMAGES) return
  }
}

/** A tool output that is just an http(s) image URL (browser screenshots). */
function collectUrlString(value: string, images: ToolImage[], seen: Set<string>) {
  const src = value.trim()
  if (!IMAGE_URL_PATTERN.test(src) || seen.has(src)) return
  seen.add(src)
  images.push({ src, mediaType: mediaTypeFromExtension(src), alt: imageName({}, src, images.length + 1) })
}

function parseJsonText(value: string): unknown {
  const text = value.trim()
  if (!text.startsWith("{") && !text.startsWith("[")) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function collectImages(value: unknown, images: ToolImage[], seen: Set<string>, objects: Set<object>, depth: number) {
  if (images.length >= MAX_IMAGES || depth > MAX_DEPTH) return
  if (typeof value === "string") {
    collectDataUrls(value, images, seen)
    collectUrlString(value, images, seen)
    const parsed = parseJsonText(value)
    if (parsed !== undefined) collectImages(parsed, images, seen, objects, depth + 1)
    return
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectImages(entry, images, seen, objects, depth + 1)
    return
  }
  if (!isRecord(value)) return
  if (objects.has(value)) return
  objects.add(value)

  const image = imageFromRecord(value, images.length + 1)
  if (image) {
    if (!seen.has(image.src)) {
      seen.add(image.src)
      images.push(image)
    }
    return
  }

  for (const key of IMAGE_KEYS) {
    if (key === "data" && !isRecord(value[key])) continue
    collectImages(value[key], images, seen, objects, depth + 1)
  }
}

/** Pure, no DOM: the image sources a tool part produced. */
export function extractToolImages(part: unknown): ToolImage[] {
  if (!isRecord(part)) return []
  const images: ToolImage[] = []
  const seen = new Set<string>()
  const objects = new Set<object>()
  collectImages(part.output, images, seen, objects, 0)
  collectImages(part.callProviderMetadata, images, seen, objects, 0)
  collectImages(part.providerMetadata, images, seen, objects, 0)
  return images
}

const imageCache = new WeakMap<object, ToolImage[]>()

/** Extraction runs once per part object; state updates replace the object. */
export function toolImagesFor(part: object | null | undefined): ToolImage[] {
  if (!part) return []
  const cached = imageCache.get(part)
  if (cached) return cached
  const images = extractToolImages(part)
  imageCache.set(part, images)
  return images
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`
  if (bytes >= 1_000) return `${Math.round(bytes / 1_000)} KB`
  return `${bytes} B`
}

function base64Bytes(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0
  return Math.max(0, Math.round((value.length * 3) / 4) - padding)
}

function placeholder(image: ToolImage): string {
  const data = image.src.startsWith("data:") ? image.src.split(",")[1] ?? "" : ""
  const size = data ? ` · ${formatBytes(base64Bytes(data))}` : ""
  return `[image: ${image.alt}${size}]`
}

function placeholderForDataUrl(src: string): string {
  const image: ToolImage = { src, mediaType: mediaTypeFromDataUrl(src), alt: imageName({}, src, 1) }
  return placeholder(image)
}

function replaceDataUrls(text: string): string {
  return text.replace(DATA_IMAGE_PATTERN, (src) => placeholderForDataUrl(src))
}

function sanitizeValue(value: unknown, objects: Set<object>, depth: number): unknown {
  if (depth > MAX_DEPTH) return "[truncated]"
  if (typeof value === "string") return replaceDataUrls(value)
  if (Array.isArray(value)) return value.map((entry) => sanitizeValue(entry, objects, depth + 1))
  if (!isRecord(value)) return value
  if (objects.has(value)) return "[circular]"
  objects.add(value)
  const image = imageFromRecord(value, 1)
  if (image) return placeholder(image)
  const sanitized: JsonRecord = {}
  for (const [key, entry] of Object.entries(value)) sanitized[key] = sanitizeValue(entry, objects, depth + 1)
  return sanitized
}

function parseEmbeddedJson(text: string): { start: number; end: number; value: unknown } | null {
  const objectStart = text.indexOf("{")
  const arrayStart = text.indexOf("[")
  const start = objectStart < 0 ? arrayStart : arrayStart < 0 ? objectStart : Math.min(objectStart, arrayStart)
  if (start < 0) return null
  const end = start === objectStart ? text.lastIndexOf("}") : text.lastIndexOf("]")
  if (end <= start) return null
  try {
    return { start, end, value: JSON.parse(text.slice(start, end + 1)) }
  } catch {
    return null
  }
}

/** Text for display: every image becomes a short placeholder, never base64. */
export function stripToolImages(output: unknown): string {
  if (typeof output !== "string") {
    return replaceDataUrls(JSON.stringify(sanitizeValue(output, new Set<object>(), 0), null, 2))
  }
  const embedded = parseEmbeddedJson(output)
  if (embedded) {
    const sanitized = replaceDataUrls(JSON.stringify(sanitizeValue(embedded.value, new Set<object>(), 0), null, 2))
    return `${output.slice(0, embedded.start)}${sanitized}${output.slice(embedded.end + 1)}`
  }
  return replaceDataUrls(output)
}
