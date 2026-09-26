import { FILE_URL_RE, HTTP_URL_RE } from "./pasted-text";

/**
 * Clipboard classification, done *before* the editor sees anything.
 *
 * A clipboard image is not reliably `clipboardData.files`. It can arrive as an
 * `items[]` entry of kind "file", as an `<img src="data:image/…">` inside
 * `text/html`, or as a bare `data:image/png;base64,…` in `text/plain`. Miss any
 * of those and the bytes fall through into Lexical as text — which is how a
 * base64 wall ends up in the prompt. Images must always enter the attachment
 * pipeline instead.
 */
export type ClipboardPayload =
  | { type: "image"; files: File[] }
  | { type: "files"; files: File[] }
  | { type: "uris"; uris: string[] }
  | { type: "text"; text: string }
  | { type: "empty" };

/** The structural slice of `DataTransfer` the classifier needs (testable). */
export type ClipboardLike = {
  items?: ArrayLike<{ kind: string; type: string; getAsFile: () => File | null }> | null;
  files?: ArrayLike<File> | null;
  getData: (format: string) => string;
};

const DATA_URL_RE = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+)?;base64,([a-z0-9+/=\s]*)$/i;
const HTML_IMG_SRC_RE = /<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
const IMAGE_MIME_PREFIX = "image/";

export function isDataImageUrl(value: string): boolean {
  const match = DATA_URL_RE.exec(value.trim());
  return Boolean(match) && (match?.[1] ?? "").startsWith(IMAGE_MIME_PREFIX);
}

/** `data:image/png;base64,…` → a real File, so it rides the normal pipeline. */
export function dataUrlToFile(dataUrl: string, filename: string): File | null {
  const match = DATA_URL_RE.exec(dataUrl.trim());
  if (!match) return null;
  const mime = match[1] ?? "application/octet-stream";
  let binary: string;
  try {
    binary = atob((match[2] ?? "").replace(/\s+/g, ""));
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new File([bytes], filename, { type: mime });
}

/** Every `data:image/…` source inside an HTML clipboard fragment. */
export function imageDataUrlsFromHtml(html: string): string[] {
  const found: string[] = [];
  for (const match of html.matchAll(HTML_IMG_SRC_RE)) {
    const src = match[1] ?? match[2] ?? match[3] ?? "";
    if (isDataImageUrl(src)) found.push(src);
  }
  return found;
}

function dataUrlImagesToFiles(dataUrls: string[], namePrefix: string): File[] {
  const files: File[] = [];
  dataUrls.forEach((dataUrl, index) => {
    const file = dataUrlToFile(dataUrl, `${namePrefix}-${index + 1}.png`);
    if (file) files.push(file);
  });
  return files;
}

/**
 * Explicit file/URL links from a drag (Finder / browser sets `text/uri-list`).
 * Plain text — even text containing absolute paths — is never treated as a link
 * here; that intercepted real text pastes and made paste feel broken.
 */
export function parseClipboardUriList(clipboard: Pick<ClipboardLike, "getData">): string[] {
  const raw = clipboard.getData("text/uri-list") ?? "";
  if (!raw.trim()) return [];
  const links: string[] = [];
  const seen = new Set<string>();
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (!FILE_URL_RE.test(trimmed) && !HTTP_URL_RE.test(trimmed)) continue;
    const normalized = encodeURI(trimmed);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    links.push(normalized);
  }
  return links;
}

/**
 * Order matters, and it is checked in this order:
 *   1. `items` entries that are images
 *   2. `files`
 *   3. `text/html` containing data: image sources
 *   4. `text/plain` that *is* a data: image
 *   5. `text/uri-list`
 *   6. ordinary text
 */
export function classifyClipboard(clipboard: ClipboardLike | null | undefined): ClipboardPayload {
  if (!clipboard) return { type: "empty" };

  const itemImages: File[] = [];
  const items = clipboard.items ?? [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!item || item.kind !== "file") continue;
    if (!item.type.startsWith(IMAGE_MIME_PREFIX)) continue;
    const file = item.getAsFile();
    if (file) itemImages.push(file);
  }
  if (itemImages.length) return { type: "image", files: itemImages };

  const files = Array.from(clipboard.files ?? []);
  if (files.length) return { type: "files", files };

  const htmlImages = imageDataUrlsFromHtml(clipboard.getData("text/html") ?? "");
  if (htmlImages.length) {
    const converted = dataUrlImagesToFiles(htmlImages, "pasted-image");
    if (converted.length) return { type: "image", files: converted };
  }

  const text = clipboard.getData("text/plain") ?? "";
  if (isDataImageUrl(text)) {
    const converted = dataUrlImagesToFiles([text], "pasted-image");
    if (converted.length) return { type: "image", files: converted };
  }

  const uris = parseClipboardUriList(clipboard);
  if (uris.length) return { type: "uris", uris };

  if (text) return { type: "text", text };
  return { type: "empty" };
}
