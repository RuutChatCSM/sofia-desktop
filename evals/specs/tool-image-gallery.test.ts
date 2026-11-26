import { expect } from "vitest";
import { test } from "@sofia/testkit";

import {
  buildScreenshotAnnotationAttachment,
  clampToolImageZoom,
  downloadNameForToolImage,
  fitToolImageZoom,
  latestToolImageIndex,
  toolImageGallerySelection,
  toolImageZoomAfterWheel,
  toolImageZoomPercent,
} from "../../apps/app/src/lib/tool-image-gallery";
import type { ToolImage } from "../../apps/app/src/lib/tool-images";

const image = (src: string, alt = src): ToolImage => ({ src, mediaType: "image/png", alt });

test("the gallery starts on the latest image and clamps stale selections", () => {
  expect(latestToolImageIndex(0)).toBe(0);
  expect(latestToolImageIndex(1)).toBe(0);
  expect(latestToolImageIndex(4)).toBe(3);

  const images = [image("a"), image("b"), image("c")];
  expect(toolImageGallerySelection(99, images)).toBe(2);
  expect(toolImageGallerySelection(-3, images)).toBe(0);
  expect(toolImageGallerySelection(1, images)).toBe(1);
  expect(toolImageGallerySelection(1, [])).toBe(0);
});

test("zoom stays between 10% and 400% and ctrl-wheel zooms in and out", () => {
  expect(clampToolImageZoom(0.01)).toBe(0.1);
  expect(clampToolImageZoom(1.5)).toBe(1.5);
  expect(clampToolImageZoom(9)).toBe(4);

  expect(toolImageZoomAfterWheel(1, -120)).toBeGreaterThan(1);
  expect(toolImageZoomAfterWheel(1, 120)).toBeLessThan(1);
  expect(toolImageZoomAfterWheel(4, -1000)).toBe(4);
  expect(toolImageZoomAfterWheel(0.1, 1000)).toBe(0.1);

  expect(toolImageZoomPercent(0.756)).toBe(76);
  expect(toolImageZoomPercent(1)).toBe(100);
});

test("fit shrinks large screenshots but never enlarges small ones", () => {
  expect(fitToolImageZoom({ width: 1600, height: 900 }, { width: 800, height: 450 })).toBe(0.5);
  expect(fitToolImageZoom({ width: 400, height: 300 }, { width: 800, height: 600 })).toBe(1);
  expect(fitToolImageZoom({ width: 1600, height: 900 }, { width: 0, height: 450 })).toBe(1);
});

test("download names keep the alt text and derive the extension", () => {
  expect(downloadNameForToolImage(image("x", "browser screenshot"))).toBe("browser-screenshot.png");
  expect(downloadNameForToolImage({ src: "x", mediaType: "image/jpeg", alt: "photo.jpg" })).toBe("photo.jpg");
  expect(downloadNameForToolImage(image("x", ""))).toBe("image.png");
});

test("an annotated screenshot becomes the same composer annotation shape", () => {
  const imageDataUrl = "data:image/png;base64,iVBORw0KGgo=";
  expect(buildScreenshotAnnotationAttachment({
    alt: "browser screenshot",
    note: "  The Save button is clipped.  ",
    imageDataUrl,
  })).toEqual({
    annotationContext: 'On the screenshot "browser screenshot", the user annotated. The Save button is clipped.',
    imageDataUrl,
    mediaType: "image/png",
  });
});

test("annotation attachments require a note and an image data URL", () => {
  const imageDataUrl = "data:image/png;base64,iVBORw0KGgo=";
  expect(buildScreenshotAnnotationAttachment({ alt: "x", note: "   ", imageDataUrl })).toBeNull();
  expect(buildScreenshotAnnotationAttachment({ alt: "x", note: "Look here", imageDataUrl: "https://example.com/x.png" })).toBeNull();
  expect(buildScreenshotAnnotationAttachment({ alt: "x", note: "Look here", imageDataUrl: "data:text/plain;base64,aGk=" })).toBeNull();
});
