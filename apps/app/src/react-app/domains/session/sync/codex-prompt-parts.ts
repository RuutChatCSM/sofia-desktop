// Sofia (codex) has no rich prompt-parts channel: a turn is sent either as
// flat text or as structured media inputs (`{ url }` -> the engine's
// `UserInput::Image`). Attachment image parts carry a base64 data URL, so the
// old "stringify every part" turn composition pasted megabytes of base64 into
// the prompt as literal text. Split parts instead: text and path references
// stay in the prompt, image data URLs ride as image inputs.
import type { AgentPartInput, FilePartInput, TextPartInput } from "@/app/lib/engine-types";

const IMAGE_DATA_URL_RE = /^data:image\//i;

export type CodexPromptFromParts = {
  text: string;
  images: string[];
};

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
    // Every other attachment is already a structured file part carrying its own
    // url/source; spelling its path out as prose put `file:///…` in the user's
    // own message. The path is not the message.
  }

  return { text: chunks.join(""), images };
}
