import { describe, expect, test } from "bun:test";
import type { DynamicToolUIPart, UIMessage } from "ai";

import { getArtifactsFromMessages } from "../src/lib/artifacts";
import { getAggregateSummary, getToolFamily, isAggregatableToolPart } from "../src/lib/tool-aggregate";
import { codexItemToParts } from "../src/react-app/domains/session/sync/codex-item-translator";

function fileChange(id: string, paths: string[]): Record<string, unknown> {
  return {
    id,
    type: "fileChange",
    status: "completed",
    changes: paths.map((path) => ({ path })),
  };
}

/**
 * Regression: a `fileChange` used to become a `patch` part, which the
 * render-group classifier has no case for and the aggregator rejects — so edits
 * rendered as nothing and broke every surrounding run, and "Edited files" never
 * appeared in a turn. It is the same canonical edit marker a shell command
 * (`bash`) or an edit-named tool already produces.
 */
describe("a file change is an aggregatable edit, per file", () => {
  test("each changed file becomes its own edit marker", () => {
    const parts = codexItemToParts(
      fileChange("fc-1", ["/repo/a.ts", "/repo/b.ts"]),
      "session",
      "message",
      "turn",
    ).map((part) => part as unknown as DynamicToolUIPart);

    expect(parts).toHaveLength(2);
    expect(parts.every((part) => part.type === "dynamic-tool")).toBe(true);
    expect(parts.every((part) => part.toolName === "apply_patch")).toBe(true);
    // A path is what lets the summary count files rather than calls.
    expect(parts.map((part) => (part.input as { filePath?: string }).filePath)).toEqual([
      "/repo/a.ts",
      "/repo/b.ts",
    ]);
  });

  test("the family the aggregator reads is edit, and the row says so", () => {
    const parts = codexItemToParts(
      fileChange("fc-2", ["/repo/a.ts", "/repo/a.ts", "/repo/b.ts"]),
      "session",
      "message",
      "turn",
    ).map((part) => part as unknown as DynamicToolUIPart);

    expect(parts.every((part) => getToolFamily(part) === "edit")).toBe(true);
    expect(parts.every((part) => isAggregatableToolPart(part))).toBe(true);
    // Three calls across two files reads as the two files it touched.
    expect(getAggregateSummary(parts, "past")).toBe("Edited 2 files");
  });

  test("a file change with no resolvable path is dropped rather than faked", () => {
    const parts = codexItemToParts(
      { id: "fc-3", type: "fileChange", status: "completed", changes: [{ path: "" }, {}] },
      "session",
      "message",
      "turn",
    );

    expect(parts).toEqual([]);
  });
});

function patchMessage(input: Record<string, unknown>): UIMessage {
  return {
    id: "message",
    role: "assistant",
    parts: [{
      type: "dynamic-tool",
      toolName: "apply_patch",
      toolCallId: "call",
      state: "output-available",
      input,
      output: "",
    }],
  } as unknown as UIMessage;
}

/**
 * Regression: `getArtifactsFromMessages` runs inside the MessageGroup render,
 * so a part without a patch document threw `Cannot read properties of undefined
 * (reading 'split')` and unmounted the entire app — a blank window with no
 * error boundary to catch it. Every codex edit arrives in exactly that shape:
 * `input.filePath` and no `patchText`.
 */
describe("reading artifacts survives a patch part with no patch text", () => {
  test("the file is still surfaced from the path the part carries", () => {
    const artifacts = getArtifactsFromMessages([patchMessage({ filePath: "/repo/a.ts" })]);

    expect(artifacts.map((artifact) => artifact.path)).toEqual(["/repo/a.ts"]);
  });

  test("a missing or non-string patchText is ignored, never fatal", () => {
    expect(() => getArtifactsFromMessages([patchMessage({ filePath: "/repo/a.ts", patchText: undefined })])).not.toThrow();
    expect(getArtifactsFromMessages([patchMessage({ patchText: 42 })])).toEqual([]);
  });
});
