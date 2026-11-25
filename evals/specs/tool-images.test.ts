import { expect } from "vitest";
import { test } from "@sofia/testkit";

import {
  getAggregateRowFile,
  getToolFailureReason,
  readRangeOf,
  toolDiffOf,
  type AnyToolPart,
} from "../../apps/app/src/lib/tool-aggregate";
import { extractToolImages, stripToolImages } from "../../apps/app/src/lib/tool-images";

const call = (toolName: string, input: unknown, output: unknown = "ok"): AnyToolPart => ({
  type: "dynamic-tool",
  toolName,
  toolCallId: "call-1",
  state: "output-available",
  input,
  output,
});

test("MCP content: base64 plus mimeType becomes a data URL", () => {
  const images = extractToolImages({ output: { content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }] } });
  expect(images).toEqual([{ src: "data:image/png;base64,aGVsbG8=", mediaType: "image/png", alt: "screenshot-1.png" }]);
});

test("Anthropic source blocks carry their media type", () => {
  const images = extractToolImages({ output: { content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "/9j/AA==" } }] } });
  expect(images[0]?.src).toBe("data:image/jpeg;base64,/9j/AA==");
  expect(images[0]?.mediaType).toBe("image/jpeg");
});

test("direct data URLs and http image URLs are found", () => {
  expect(extractToolImages({ output: "data:image/gif;base64,R0lGODlhAQABAAAAACw=" })[0]?.mediaType).toBe("image/gif");
  expect(extractToolImages({ output: [{ type: "input_image", image_url: "https://example.com/shot.png" }] })[0]?.src).toBe("https://example.com/shot.png");
});

test("a plain output URL is an image only when it points at an image file", () => {
  expect(extractToolImages({ output: "https://example.com/shot.png" })[0]?.src).toBe("https://example.com/shot.png");
  expect(extractToolImages({ output: { content: [{ type: "link", url: "https://example.com/docs" }] } })).toEqual([]);
});

test("codex image_url objects are found inside contentItems", () => {
  const images = extractToolImages({ output: { contentItems: [{ type: "image_url", image_url: { url: "https://example.com/a.webp" } }] } });
  expect(images).toEqual([{ src: "https://example.com/a.webp", mediaType: "image/webp", alt: "a.webp" }]);
});

test("images persisted in MCP provider metadata are found", () => {
  const images = extractToolImages({
    callProviderMetadata: { sofia: { mcpResult: { content: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }] } } },
  });
  expect(images[0]?.mediaType).toBe("image/png");
});

test("stripToolImages replaces image data with a short placeholder", () => {
  const text = stripToolImages({ output: { content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }] } });
  expect(text).toContain("[image: screenshot-1.png · 5 B]");
  expect(text).not.toContain("aGVsbG8=");
});

test("stripToolImages strips embedded data URLs but keeps surrounding text", () => {
  const text = stripToolImages("before\nconst src = 'data:image/png;base64,aGVsbG8='\nafter");
  expect(text).toContain("before");
  expect(text).toContain("after");
  expect(text).toMatch(/\[image: screenshot-1\.png · 5 B\]/);
  expect(text).not.toContain("aGVsbG8=");
});

test("a failed read of a missing file is unavailable, not an empty preview", () => {
  const part = call("read", { filePath: "/repo/missing.ts" });
  const failed: AnyToolPart = { ...part, state: "output-error", errorText: "ENOENT: no such file or directory, open '/repo/missing.ts'" };
  expect(getAggregateRowFile(failed)).toMatchObject({ verb: "Read", path: "/repo/missing.ts", unavailable: true });
  expect(getToolFailureReason(failed)).toEqual({
    summary: "ENOENT: no such file or directory, open '/repo/missing.ts'",
    detail: "ENOENT: no such file or directory, open '/repo/missing.ts'",
  });
});

test("the failure reason also comes from structured output", () => {
  const part = call("browser_click", {});
  const failed: AnyToolPart = { ...part, state: "output-error", errorText: JSON.stringify({ error: "Element not found", details: [{ message: "No button named Save" }] }) };
  const reason = getToolFailureReason(failed);
  expect(reason?.summary).toBe("Element not found");
  expect(reason?.detail).toContain("No button named Save");
  expect(getToolFailureReason({ ...failed, errorText: "tool failed" })).toBeNull();
});

test("read ranges come from output coordinates or input offset/limit", () => {
  const fromOutput = call("read", { filePath: "/repo/a.ts" }, "(Showing lines 10-20 of 100. Use offset=20 to continue.)");
  expect(readRangeOf(fromOutput)).toEqual({ start: 10, end: 20 });
  const fromInput = call("read", { filePath: "/repo/a.ts", offset: 5, limit: 3 });
  expect(readRangeOf(fromInput)).toEqual({ start: 6, end: 8 });
});

test("edit clicks carry a diff, synthesized when the tool omits one", () => {
  const edit = call("edit", { filePath: "/repo/a.ts", oldString: "old", newString: "new" });
  expect(toolDiffOf(edit)).toContain("@@ -1,1 +1,1 @@");
  expect(toolDiffOf(edit)).toContain("-old");
  expect(toolDiffOf(edit)).toContain("+new");
  expect(getAggregateRowFile(edit)?.diff).toBe(toolDiffOf(edit));
});
