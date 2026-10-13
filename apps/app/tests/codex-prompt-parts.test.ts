import { describe, expect, test } from "bun:test";

import type { AgentPartInput, FilePartInput, TextPartInput } from "../src/app/lib/engine-types";
import { codexPromptFromParts } from "../src/react-app/domains/session/sync/codex-prompt-parts";
import { parseMessageReference } from "../src/react-app/domains/session/surface/composer/message-reference";

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

  test("a tagged @file survives as a readable reference, never as a raw file:// URL", () => {
    // Sofia sends a turn as flat text, so a non-image file part has no
    // structured channel: its path must ride in the prompt or a tagged `@file`
    // reaches the engine as an empty message. The readable reference carries the
    // path the model can read while the transcript renders a chip — no `file:///`
    // URL is spelled into the user's own message.
    const parts = [
      filePart({ url: "file:///workspace/src/report.pdf", mime: "application/pdf", filename: "report.pdf" }),
      filePart({ url: "data:text/plain;base64,aGVsbG8=", mime: "text/plain", filename: "notes.txt" }),
    ];

    const { text, images } = codexPromptFromParts(parts);

    expect(images).toEqual([]);
    expect(text).toBe('[File: "/workspace/src/report.pdf"]');
    expect(text).not.toContain("file:///");
    expect(text).not.toContain("aGVsbG8=");
    expect(parseMessageReference(text)?.path).toBe("/workspace/src/report.pdf");
  });

  test("a workspace copy without a file:// url still reaches the prompt via source.path", () => {
    const parts = [
      filePart({
        url: "data:application/pdf;base64,AAAA",
        mime: "application/pdf",
        filename: "scan.pdf",
        source: { type: "file", path: ".sofia/sofia/inbox/chat-attachments/scan.pdf", text: { value: "scan.pdf", start: 0, end: 0 } },
      }),
    ];

    const { text } = codexPromptFromParts(parts);

    expect(parseMessageReference(text)?.path).toBe(".sofia/sofia/inbox/chat-attachments/scan.pdf");
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
