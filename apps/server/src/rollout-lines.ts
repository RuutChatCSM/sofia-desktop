import { open } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";

export const MAX_ROLLOUT_LINE_CHARS = 64 * 1024 * 1024;

export class RolloutRecordTooLargeError extends Error {}

/**
 * Snapshot-length, chunked JSONL reads: never allocate the entire rollout and
 * never block the event loop. Rollouts reach hundreds of MB; a synchronous read
 * froze every SSE stream this server serves until it finished.
 */
export async function* readRolloutLines(path: string): AsyncGenerator<string> {
  const handle = await open(path, "r");
  try {
    const size = (await handle.stat()).size;
    const buffer = Buffer.alloc(256 * 1024);
    const decoder = new StringDecoder("utf8");
    let offset = 0;
    let pending = "";
    while (offset < size) {
      const { bytesRead: bytes } = await handle.read(buffer, 0, Math.min(buffer.length, size - offset), offset);
      if (!bytes) break;
      offset += bytes;
      const chunk = decoder.write(buffer.subarray(0, bytes));
      let start = 0;
      for (;;) {
        const end = chunk.indexOf("\n", start);
        const segment = end < 0 ? chunk.slice(start) : chunk.slice(start, end);
        if (pending.length + segment.length > MAX_ROLLOUT_LINE_CHARS) {
          throw new RolloutRecordTooLargeError("Session history contains a record exceeding the safe 64 Mi-character read limit.");
        }
        pending += segment;
        if (end < 0) break;
        yield pending;
        pending = "";
        start = end + 1;
      }
    }
    pending += decoder.end();
    if (pending) yield pending;
  } finally {
    await handle.close();
  }
}
