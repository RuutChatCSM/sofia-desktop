import type { FilePartInput } from "@/app/lib/engine-types";
import type { ComposerDraft } from "@/app/types";
import type { UIMessage } from "ai";

const INLINE_MEDIA_LIMIT = 900_000;
const PREVIEWABLE_MIME = /^(?:video\/|audio\/|application\/pdf$)/;

async function previewUrl(file: File, mime: string, fallback: string): Promise<string> {
  if (!PREVIEWABLE_MIME.test(mime) || file.size > INLINE_MEDIA_LIMIT) return fallback;
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

/** The user's visible text and attachment chips, in the editor's order. */
export async function transcriptDisplayParts(
  draft: ComposerDraft,
  uploaded: ReadonlyMap<string, FilePartInput>,
): Promise<UIMessage["parts"]> {
  const files = new Map<string, Extract<UIMessage["parts"][number], { type: "file" }>>();
  for (const attachment of draft.attachments) {
    const part = uploaded.get(attachment.id);
    if (!part) continue;
    if (attachment.annotationContext) {
      files.set(attachment.id, {
        type: "file",
        mediaType: "application/x-sofia-annotation",
        filename: "Annotation",
        url: `data:application/x-sofia-annotation,${encodeURIComponent(attachment.annotationContext)}`,
      });
      continue;
    }
    const mime = attachment.mimeType || part.mime;
    files.set(attachment.id, {
      type: "file",
      mediaType: mime,
      filename: attachment.name,
      url: await previewUrl(attachment.file, mime, part.url),
    });
  }

  const result: UIMessage["parts"] = [];
  for (const segment of draft.text.split(/(\[attachment [^\]]+\])/)) {
    if (!segment) continue;
    const match = segment.match(/^\[attachment ([^\]]+)\]$/);
    if (!match) {
      result.push({ type: "text", text: segment, state: "done" });
      continue;
    }
    const file = files.get(match[1]);
    if (file) {
      result.push(file);
      files.delete(match[1]);
    }
  }
  result.push(...files.values());
  return result;
}
