import { describe, expect, test } from "bun:test";

import type { AgentPartInput, FilePartInput, TextPartInput } from "../src/app/lib/engine-types";
import { codexPromptFromParts } from "../src/react-app/domains/session/sync/codex-prompt-parts";

const PNG_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";

function filePart(part: Partial<FilePartInput> & Pick<FilePartInput, "url">): FilePartInput {
  return { type: "file", mime: "text/plain", filename: "file.txt", ...part };
}

describe("codexPromptFromParts", () => {
  test("keeps text parts in the prompt and never inlines an image data URL", () => {
    const parts: Array<TextPartInput | FilePartInput | AgentPartInput> = [
      { type: "text", text: "what is in this shot?" },
      filePart({ url: PNG_DATA_URL, mime: "image/png", filename: "shot.png" }),
    ];

    const { text, images } = codexPromptFromParts(parts);

    expect(images).toEqual([PNG_DATA_URL]);
    expect(text).toBe("what is in this shot?");
    expect(text).not.toContain("base64");
    expect(text).not.toContain("data:image");
  });

  test("the attachment path is never the message", () => {
    // A workspace copy path used to be spelled out as prompt prose, so the
    // user's own message rendered `file:///…` and `.sofia/…/chat-attachments/`.
    // The part already carries its own url/source; nothing belongs in the text.
    const parts = [
      filePart({ url: "file:///workspace/.sofia/inbox/scan.pdf", mime: "application/pdf", filename: "scan.pdf" }),
      filePart({ url: "data:text/plain;base64,aGVsbG8=", mime: "text/plain", filename: "notes.txt" }),
    ];

    const { text, images } = codexPromptFromParts(parts);

    expect(images).toEqual([]);
    expect(text).toBe("");
    expect(text).not.toContain("file:///");
    expect(text).not.toContain("chat-attachments");
    expect(text).not.toContain("aGVsbG8=");
  });

  test("never echoes runtime plumbing as user text", () => {
    const parts: Array<TextPartInput | FilePartInput | AgentPartInput> = [
      {
        type: "text",
        synthetic: true,
        text: "Attached files were copied into this worker workspace for tool access:\n- scan.pdf: .sofia/sofia/inbox/chat-attachments/scan.pdf",
      },
      { type: "text", text: "what does this say?" },
    ];

    const { text } = codexPromptFromParts(parts);

    expect(text).toBe("what does this say?");
    expect(text).not.toContain("Attached files were copied");
  });

  test("collects every image input and still describes agent parts", () => {
    const parts: Array<TextPartInput | FilePartInput | AgentPartInput> = [
      filePart({ url: PNG_DATA_URL, mime: "image/png", filename: "one.png" }),
      filePart({ url: "data:image/jpeg;base64,/9j/4A==", mime: "image/jpeg", filename: "two.jpg" }),
      { type: "agent", name: "reviewer" },
    ];

    const { text, images } = codexPromptFromParts(parts);

    expect(images).toEqual([PNG_DATA_URL, "data:image/jpeg;base64,/9j/4A=="]);
    expect(text).toBe("Use the reviewer agent. ");
  });
});
