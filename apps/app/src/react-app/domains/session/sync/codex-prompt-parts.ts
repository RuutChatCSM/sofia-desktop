// Sofia (codex) has no rich prompt-parts channel: a turn is sent either as
// flat text or as structured media inputs (`{ url }` -> the engine's
// `UserInput::Image`). Attachment image parts carry a base64 data URL, so the
// old "stringify every part" turn composition pasted megabytes of base64 into
// the prompt as literal text. Split parts instead: text and path references
// stay in the prompt, image data URLs ride as image inputs.
import type { AgentPartInput, FilePartInput, TextPartInput } from "@/app/lib/engine-types";

import { filePathFromFileUrl } from "../artifacts/open-target";
import { createMessageReference, serializeMessageReference } from "../surface/composer/message-reference";

const IMAGE_DATA_URL_RE = /^data:image\//i;

export type CodexPromptFromParts = {
  text: string;
  images: string[];
};

/**
 * The workspace path a file part points at: the absolute `file://` url when it
 * has one (a tagged `@file`), otherwise the attachment's copied `source.path`.
 */
function filePartPath(part: FilePartInput): string {
  const absolute = filePathFromFileUrl(part.url);
  if (absolute) return absolute;
  return part.source?.type === "file" ? part.source.path : "";
}

export function codexPromptFromParts(
  parts: ReadonlyArray<TextPartInput | FilePartInput | AgentPartInput>,
): CodexPromptFromParts {
  const images: string[] = [];
  const chunks: string[] = [];

  for (const part of parts) {
    if (part.type === "text") {
      // `synthetic` text is runtime plumbing (workspace-copy notes and other
      // internal context), never something the user wrote or should see echoed
      // back at them.
      if (part.synthetic) continue;
      chunks.push(part.text);
      continue;
    }
    if (part.type === "agent") {
      chunks.push(`Use the ${part.name} agent. `);
      continue;
    }
    // Images ride as structured image inputs.
    if (IMAGE_DATA_URL_RE.test(part.url)) {
      images.push(part.url);
      continue;
    }
    // Sofia sends a turn as flat text, so a workspace file part that is not an
    // image has no structured channel: its path must ride in the prompt or the
    // file never reaches the engine (a tagged `@file` read as an empty message).
    // Use the same readable, self-contained reference the composer and
    // transcript render, so the path arrives without a raw `file:///…` URL in
    // the user's own message.
    const path = filePartPath(part);
    if (path) chunks.push(serializeMessageReference(createMessageReference(path)));
  }

  return { text: chunks.join(""), images };
}
