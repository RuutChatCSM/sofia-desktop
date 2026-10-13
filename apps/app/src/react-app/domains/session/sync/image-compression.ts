import type {} from "@/app/lib/desktop";

const IMAGE_COMPRESS_MAX_PX = 2048;
const IMAGE_COMPRESS_QUALITY = 0.82;
const IMAGE_COMPRESS_TARGET_BYTES = 1_500_000;

/**
 * Re-encode oversized images as JPEG before upload / prompt inlining.
 *
 * Runs at send time (inside the async send pipeline, while attachment chips
 * show their uploading state) instead of at attach time, so dropping a large
 * photo into the composer shows its chip immediately rather than blocking the
 * UI on canvas work (#attachment-upload-ux).
 */
export function isHeicImage(file: Pick<File, "name" | "type">): boolean {
  return /\.hei[cf]$/i.test(file.name) || /^image\/hei[cf](?:-sequence)?$/i.test(file.type);
}

export async function normalizeImageFile(file: File): Promise<File> {
  if (!isHeicImage(file)) return file;
  const decode = window.__SOFIA_ELECTRON__?.images?.decodeHeic;
  if (!decode) throw new Error("HEIC preview is unavailable here. Export this image as PNG or JPEG and attach it again.");
  const bytes = await decode(new Uint8Array(await file.arrayBuffer()));
  return new File([new Uint8Array(bytes)], file.name.replace(/\.hei[cf]$/i, "") + ".png", { type: "image/png" });
}

export async function compressImageFile(input: File): Promise<File> {
  const file = await normalizeImageFile(input);
  if (!file.type.startsWith("image/")) return file;
  if (file.type === "image/gif" || file.size <= IMAGE_COMPRESS_TARGET_BYTES) {
    return file;
  }

  const bitmap = await createImageBitmap(file);
  const { width, height } = bitmap;
  const maxDim = Math.max(width, height);
  const scale = maxDim > IMAGE_COMPRESS_MAX_PX ? IMAGE_COMPRESS_MAX_PX / maxDim : 1;
  const targetW = Math.round(width * scale);
  const targetH = Math.round(height * scale);

  let blob: Blob | null = null;

  if (typeof OffscreenCanvas !== "undefined") {
    const offscreen = new OffscreenCanvas(targetW, targetH);
    const ctx = offscreen.getContext("2d");
    if (ctx) {
      ctx.drawImage(bitmap, 0, 0, targetW, targetH);
      blob = await offscreen.convertToBlob({
        type: "image/jpeg",
        quality: IMAGE_COMPRESS_QUALITY,
      });
    }
  }

  if (!blob) {
    const canvas = document.createElement("canvas");
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.drawImage(bitmap, 0, 0, targetW, targetH);
      blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/jpeg", IMAGE_COMPRESS_QUALITY),
      );
    }
  }

  bitmap.close();

  if (!blob || blob.size >= file.size) {
    return file;
  }

  const stem = file.name.replace(/\.[^.]+$/, "") || "image";
  return new File([blob], `${stem}.jpg`, { type: "image/jpeg" });
}
