import { describe, expect, test } from "bun:test";
import type { FilePartInput } from "../src/app/lib/engine-types";
import type { ComposerAttachment, ComposerDraft } from "../src/app/types";
import { transcriptDisplayParts } from "../src/react-app/domains/session/sync/transcript-display-parts";

function attachment(id: string, name: string, mimeType: string, content: string): ComposerAttachment {
  const file = new File([content], name, { type: mimeType });
  return { id, name, mimeType, size: file.size, kind: "file", file };
}

function draft(text: string, attachments: ComposerAttachment[]): ComposerDraft {
  return { mode: "prompt", text, parts: [{ type: "text", text }], attachments };
}

function uploaded(name: string, mime: string): FilePartInput {
  return { type: "file", filename: name, mime, url: `file:///workspace/${name}` };
}

describe("transcript display parts", () => {
  test("keeps two attachments between the words where they were composed", async () => {
    const first = attachment("a", "one.txt", "text/plain", "one");
    const second = attachment("b", "two.txt", "text/plain", "two");
    const parts = await transcriptDisplayParts(draft("before [attachment a] middle [attachment b] after", [first, second]),
      new Map([["a", uploaded("one.txt", "text/plain")], ["b", uploaded("two.txt", "text/plain")]]));
    expect(parts.map((part) => part.type === "text" ? part.text : part.type === "file" ? part.filename : "other"))
      .toEqual(["before ", "one.txt", " middle ", "two.txt", " after"]);
  });

  test("stores small media inline and keeps a file fallback for large media", async () => {
    const small = attachment("audio", "note.wav", "audio/wav", "sound");
    const large = attachment("video", "clip.mp4", "video/mp4", "x".repeat(900_001));
    const parts = await transcriptDisplayParts(draft("[attachment audio] [attachment video]", [small, large]),
      new Map([["audio", uploaded("note.wav", "audio/wav")], ["video", uploaded("clip.mp4", "video/mp4")]]));
    expect(parts[0]?.type === "file" && parts[0].url.startsWith("data:audio/wav;base64,")).toBe(true);
    expect(parts[2]?.type === "file" && parts[2].url).toBe("file:///workspace/clip.mp4");
  });
});
