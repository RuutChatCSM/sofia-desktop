import { describe, expect, test } from "bun:test";

import { hunkSideText, languageForPath } from "../src/react-app/domains/session/changes/diff-highlight";

describe("diff language detection", () => {
  test("maps the extensions this repo actually contains", () => {
    expect(languageForPath("apps/server/src/git-changes.ts")).toBe("typescript");
    expect(languageForPath("review-pane.tsx")).toBe("tsx");
    expect(languageForPath("panel-tab-store.ts")).toBe("typescript");
    expect(languageForPath("scripts/build.mjs")).toBe("javascript");
    expect(languageForPath("apps/app/src/app/index.css")).toBe("css");
    expect(languageForPath("README.md")).toBe("markdown");
    expect(languageForPath("sofia-rs/core/src/client.rs")).toBe("rust");
    expect(languageForPath("packages/types/src/sofia-context.ts")).toBe("typescript");
  });

  test("unknown or extensionless files are plain text, not a guess", () => {
    expect(languageForPath("Dockerfile")).toBe("text");
    expect(languageForPath("LICENSE")).toBe("text");
    expect(languageForPath("assets/hero.png")).toBe("text");
    expect(languageForPath("notes.unknownext")).toBe("text");
  });
});

describe("hunk side text", () => {
  test("each side carries only the rows it renders, in order", () => {
    const hunk = {
      lines: [
        { type: "context" as const, text: "keep" },
        { type: "delete" as const, text: "old line" },
        { type: "add" as const, text: "new line" },
        { type: "context" as const, text: "tail" },
      ],
    };

    // The viewer walks rows and consumes one token line per non-blank cell, so
    // the counts must match exactly or colour lands on the wrong line.
    expect(hunkSideText(hunk, "old")).toBe("keep\nold line\ntail");
    expect(hunkSideText(hunk, "new")).toBe("keep\nnew line\ntail");
  });

  test("an empty hunk yields no text", () => {
    expect(hunkSideText({ lines: [] }, "old")).toBe("");
  });
});
