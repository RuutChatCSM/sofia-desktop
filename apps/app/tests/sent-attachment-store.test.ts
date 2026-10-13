import { afterEach, describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";

import {
  recordSentAttachments,
  resetSentAttachmentCache,
  sentAttachments,
  setSentAttachmentBackend,
  whenSentAttachmentsReady,
  type SentAttachmentBackend,
} from "../src/react-app/domains/session/sync/sent-attachment-store";

const DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";

/** Stand-in for IndexedDB: records land in a Map the moment they are saved, so
 * a test can drop the in-memory cache and read them back like a reload would. */
function fakeBackend() {
  const rows = new Map<string, unknown>();
  let saves = 0;
  const backend: SentAttachmentBackend = {
    load: async () => Object.fromEntries(rows) as never,
    save: async (shape) => {
      saves += 1;
      rows.clear();
      for (const [sessionId, entries] of Object.entries(shape)) rows.set(sessionId, entries);
    },
  };
  return { backend, rows, saved: () => saves };
}

const imagePart = (url = DATA_URL): UIMessage["parts"][number] => ({
  type: "file",
  mediaType: "image/png",
  filename: "shot.png",
  url,
});

afterEach(() => {
  setSentAttachmentBackend(null);
});

describe("sent attachment store", () => {
  test("keeps a sent image across a simulated reload", async () => {
    const { backend } = fakeBackend();
    setSentAttachmentBackend(backend);
    recordSentAttachments("codex-1", "look at this", [imagePart()]);
    await whenSentAttachmentsReady();

    // A reload drops the in-memory cache; the durable copy is all that is left.
    resetSentAttachmentCache();
    await whenSentAttachmentsReady();
    expect(sentAttachments("codex-1")).toEqual([{ text: "look at this", parts: [imagePart()] }]);
  });

  test("two turns with the same text retain their distinct attachments", () => {
    setSentAttachmentBackend(fakeBackend().backend);
    recordSentAttachments("codex-1", "same", [imagePart()]);
    recordSentAttachments("codex-1", "same", [imagePart("data:image/png;base64,second")]);
    expect(sentAttachments("codex-1").map((entry) => entry.parts[0])).toEqual([
      imagePart(), imagePart("data:image/png;base64,second"),
    ]);
  });

  test("drops parts it cannot render later: blob previews and oversized images", () => {
    setSentAttachmentBackend(fakeBackend().backend);
    recordSentAttachments("codex-1", "blob", [imagePart("blob:http://localhost/x")]);
    recordSentAttachments("codex-1", "huge", [imagePart(`data:image/png;base64,${"A".repeat(1_600_000)}`)]);
    expect(sentAttachments("codex-1")).toEqual([]);
  });

  test("ignores a message with no durable part", () => {
    setSentAttachmentBackend(fakeBackend().backend);
    recordSentAttachments("codex-1", "nothing", []);
    expect(sentAttachments("codex-1")).toEqual([]);
  });

  test("keeps only the newest messages per session", () => {
    setSentAttachmentBackend(fakeBackend().backend);
    for (let index = 0; index < 60; index += 1) {
      recordSentAttachments("codex-1", `message ${index}`, [imagePart()]);
    }
    const kept = sentAttachments("codex-1");
    expect(kept).toHaveLength(40);
    expect(kept.at(-1)?.text).toBe("message 59");
  });

  test("a read that races the first save never loses the just-sent image", async () => {
    const { backend, rows } = fakeBackend();
    rows.set("codex-1", [{ text: "older", parts: [imagePart()] }]);
    setSentAttachmentBackend(backend);
    // The user sends before hydration lands, then hydration completes.
    recordSentAttachments("codex-1", "fresh", [imagePart()]);
    await whenSentAttachmentsReady();
    expect(sentAttachments("codex-1").map((entry) => entry.text)).toEqual(["older", "fresh"]);
  });
});
