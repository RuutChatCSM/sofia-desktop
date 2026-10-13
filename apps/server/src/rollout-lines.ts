import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

export const MAX_ROLLOUT_LINE_CHARS = 64 * 1024 * 1024;

export class RolloutRecordTooLargeError extends Error {}

/** Snapshot-length, chunked JSONL reads: never allocate the entire rollout. */
export function* readRolloutLines(path: string): Generator<string> {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const buffer = Buffer.alloc(256 * 1024);
    const decoder = new StringDecoder("utf8");
    let offset = 0;
    let pending = "";
    while (offset < size) {
      const bytes = readSync(fd, buffer, 0, Math.min(buffer.length, size - offset), offset);
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
    closeSync(fd);
  }
}
