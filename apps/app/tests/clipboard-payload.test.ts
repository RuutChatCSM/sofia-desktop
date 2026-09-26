import { describe, expect, test } from "bun:test";

import {
  classifyClipboard,
  dataUrlToFile,
  imageDataUrlsFromHtml,
  isDataImageUrl,
  type ClipboardLike,
} from "../src/react-app/domains/session/surface/composer/clipboard-payload";

const PNG_DATA_URL = "data:image/png;base64,iVBORw0KGgo=";
const OCTET_DATA_URL = `data:application/octet-stream;base64,${"A".repeat(64)}`;

function clipboard(payload: Partial<ClipboardLike> & { data?: Record<string, string> }): ClipboardLike {
  const { data = {}, ...rest } = payload;
  return {
    items: null,
    files: null,
    getData: (format) => data[format] ?? "",
    ...rest,
  };
}

function imageItem(name: string) {
  const file = new File([new Uint8Array([1, 2, 3])], name, { type: "image/png" });
  return { kind: "file", type: "image/png", getAsFile: () => file };
}

describe("clipboard classification runs before the editor sees anything", () => {
  test("a clipboard image arrives as items, not files", () => {
    const payload = classifyClipboard(
      clipboard({ items: [imageItem("screenshot.png")], data: { "text/html": "", "text/plain": "" } }),
    );

    expect(payload.type).toBe("image");
    expect(payload.type === "image" && payload.files).toHaveLength(1);
    expect(payload.type === "image" && payload.files[0]?.name).toBe("screenshot.png");
  });

  test("items images win over a mirrored files list", () => {
    const viaItem = imageItem("from-items.png");
    const payload = classifyClipboard(
      clipboard({
        items: [viaItem],
        files: [new File([new Uint8Array([9])], "from-files.png", { type: "image/png" })],
      }),
    );

    expect(payload.type).toBe("image");
    expect(payload.type === "image" && payload.files[0]?.name).toBe("from-items.png");
  });

  test("ordinary file payloads go to the attachment pipeline", () => {
    const payload = classifyClipboard(
      clipboard({ files: [new File(["%PDF"], "report.pdf", { type: "application/pdf" })] }),
    );
    expect(payload.type).toBe("files");
  });

  test("an <img src=\"data:image/…\"> in text/html becomes an image file", () => {
    const html = `<meta charset="utf-8"><img src="${PNG_DATA_URL}">`;
    const payload = classifyClipboard(clipboard({ data: { "text/html": html, "text/plain": "" } }));

    expect(payload.type).toBe("image");
    expect(payload.type === "image" && payload.files[0]?.type).toBe("image/png");
  });

  test("a bare data:image URI in text/plain becomes an image file", () => {
    const payload = classifyClipboard(clipboard({ data: { "text/plain": PNG_DATA_URL } }));

    expect(payload.type).toBe("image");
    expect(payload.type === "image" && payload.files).toHaveLength(1);
  });

  test("non-image encoded blobs are still text, so the send gate must strip them", () => {
    const payload = classifyClipboard(clipboard({ data: { "text/plain": OCTET_DATA_URL } }));

    expect(payload.type).toBe("text");
    expect(payload.type === "text" && payload.text).toBe(OCTET_DATA_URL);
  });

  test("drag-and-dropped links keep the uri-list path", () => {
    const payload = classifyClipboard(
      clipboard({ data: { "text/uri-list": "file:///Users/mona/report.pdf\r\nhttps://example.com/x" } }),
    );

    expect(payload.type).toBe("uris");
    expect(payload.type === "uris" && payload.uris).toHaveLength(2);
  });

  test("ordinary text and empty clipboards are left to the editor", () => {
    expect(classifyClipboard(clipboard({ data: { "text/plain": "hello world" } })).type).toBe("text");
    expect(classifyClipboard(clipboard({})).type).toBe("empty");
    expect(classifyClipboard(null).type).toBe("empty");
  });
});

describe("data URL image decoding", () => {
  test("recognises only image data URLs", () => {
    expect(isDataImageUrl(PNG_DATA_URL)).toBeTrue();
    expect(isDataImageUrl(OCTET_DATA_URL)).toBeFalse();
    expect(isDataImageUrl("https://example.com/a.png")).toBeFalse();
  });

  test("decodes the payload into real bytes", async () => {
    const file = dataUrlToFile("data:image/png;base64,AAEC", "x.png");
    expect(file?.type).toBe("image/png");
    expect(Array.from(new Uint8Array(await file!.arrayBuffer()))).toEqual([0, 1, 2]);
    expect(dataUrlToFile("data:image/png;base64,%%%%", "x.png")).toBeNull();
    expect(dataUrlToFile("not-a-data-url", "x.png")).toBeNull();
  });

  test("finds every data-image source in an html fragment", () => {
    expect(imageDataUrlsFromHtml(`<img src='${PNG_DATA_URL}'><img src="https://x/y.png">`)).toEqual([
      PNG_DATA_URL,
    ]);
  });
});
