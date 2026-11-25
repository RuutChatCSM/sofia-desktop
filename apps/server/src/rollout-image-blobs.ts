import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/**
 * Image blob references written by the Sofia engine (sofia-rs/rollout/src/image_blobs.rs).
 *
 * Large image data URLs in new rollouts are stored once at
 * `<sofia_home>/blobs/sha256/<first 2 hex>/<64 hex>` (file contents: the exact data URL)
 * and the rollout line holds `sofia-blob:sha256:<64 hex>` instead. Keep this in sync with
 * the engine contract.
 */
export const BLOB_REFERENCE_PREFIX = "sofia-blob:sha256:";
const REFERENCE = /^sofia-blob:sha256:([0-9a-f]{64})$/;

/** The Sofia home that owns a rollout: the parent of its sessions/archived_sessions dir. */
export function sofiaHomeForRollout(rolloutPath: string): string | null {
  for (let dir = dirname(rolloutPath); dir !== dirname(dir); dir = dirname(dir)) {
    const name = basename(dir);
    if (name === "sessions" || name === "archived_sessions") return dirname(dir);
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Replace, in place, every blob reference inside freshly parsed rollout items with its data
 * URL. A missing blob leaves the reference (the image fails to render) instead of failing
 * the whole read.
 */
export async function resolveImageBlobReferences(items: unknown[], sofiaHome: string): Promise<void> {
  const resolved = new Map<string, Promise<string>>();
  const resolve = (reference: string, hash: string) => {
    let pending = resolved.get(hash);
    if (!pending) {
      pending = readFile(join(sofiaHome, "blobs", "sha256", hash.slice(0, 2), hash), "utf8").catch(() => reference);
      resolved.set(hash, pending);
    }
    return pending;
  };
  const walk = async (node: unknown): Promise<unknown> => {
    if (typeof node === "string") {
      const hash = node.startsWith(BLOB_REFERENCE_PREFIX) ? REFERENCE.exec(node)?.[1] : undefined;
      return hash ? await resolve(node, hash) : node;
    }
    if (Array.isArray(node)) {
      for (let index = 0; index < node.length; index += 1) node[index] = await walk(node[index]);
    } else if (isRecord(node)) {
      for (const key of Object.keys(node)) node[key] = await walk(node[key]);
    }
    return node;
  };
  await walk(items);
}
