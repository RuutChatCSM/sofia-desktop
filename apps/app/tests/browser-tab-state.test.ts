import { describe, expect, test } from "bun:test";

import {
  BROWSER_ZOOM_STEPS,
  browserToolbarDensity,
  browserUrlParts,
  browserPanThumbLength,
  browserViewportLabel,
  browserViewportPresetId,
  browserZoomLabel,
  formatBrowserScalePercent,
  normalizeBrowserZoom,
} from "../src/app/lib/browser-tab-state";

describe("browser viewport labels", () => {
  test("names panel mode by behaviour, not by absence", () => {
    expect(browserViewportLabel({ mode: "panel" })).toBe("Panel");
    expect(browserViewportLabel({ mode: "responsive", width: 390, height: 844, deviceScaleFactor: 1 }))
      .toBe("390 × 844");
  });

  test("matches presets by dimensions and calls anything else custom", () => {
    expect(browserViewportPresetId({ mode: "panel" })).toBeNull();
    expect(browserViewportPresetId({ mode: "responsive", width: 1440, height: 900, deviceScaleFactor: 1 })).toBe("desktop");
    expect(browserViewportPresetId({ mode: "responsive", width: 1366, height: 768, deviceScaleFactor: 1 })).toBeNull();
  });
});

describe("browser zoom labels", () => {
  test("fit reports the applied scale as a consequence, never as state", () => {
    expect(browserZoomLabel({ mode: "fit" }, 0.5143)).toBe("Fit · 51%");
    expect(browserZoomLabel({ mode: "fit" }, null)).toBe("Fit");
    expect(browserZoomLabel({ mode: "actual" }, 0.5)).toBe("Actual size");
    expect(browserZoomLabel({ mode: "custom", scale: 0.75 }, null)).toBe("75%");
    expect(formatBrowserScalePercent(1.5)).toBe("150%");
  });

  test("custom zoom normalizes to a usable scale", () => {
    expect(normalizeBrowserZoom({ mode: "custom", scale: 0.42 })).toEqual({ mode: "custom", scale: 0.42 });
    expect(normalizeBrowserZoom({ mode: "custom", scale: 99 })).toEqual({ mode: "custom", scale: 5 });
    expect(normalizeBrowserZoom({ mode: "custom" })).toEqual({ mode: "custom", scale: 1 });
    expect(normalizeBrowserZoom("nonsense")).toEqual({ mode: "fit" });
    expect(BROWSER_ZOOM_STEPS).toContain(0.75);
  });
});

describe("browser address bar", () => {
  test("splits host from path and flags loopback", () => {
    expect(browserUrlParts("http://localhost:3000/dashboard?team=abc")).toEqual({
      host: "localhost:3000",
      rest: "/dashboard?team=abc",
      insecure: true,
      loopback: true,
    });
    expect(browserUrlParts("https://github.com/RuutChatCSM/sofia")).toEqual({
      host: "github.com",
      rest: "/RuutChatCSM/sofia",
      insecure: false,
      loopback: false,
    });
    expect(browserUrlParts("about:blank")).toBeNull();
    expect(browserUrlParts("")).toBeNull();
  });
});

describe("browser toolbar density", () => {
  test("degrades labels instead of crushing controls", () => {
    expect(browserToolbarDensity(900)).toBe("full");
    expect(browserToolbarDensity(720)).toBe("full");
    expect(browserToolbarDensity(620)).toBe("compact");
    expect(browserToolbarDensity(520)).toBe("compact");
    expect(browserToolbarDensity(430)).toBe("essential");
  });
});

describe("browser pan thumb", () => {
  test("fills the track when nothing overflows and shrinks proportionally when it does", () => {
    expect(browserPanThumbLength({ contentLength: 390, overflow: 0, trackLength: 300 })).toBe(300);
    // 1440 scaled to 1:1 inside a 700px canvas: 700 of 1440 visible.
    expect(browserPanThumbLength({ contentLength: 1440, overflow: 740, trackLength: 300 })).toBe(146);
    // Never thinner than the 24px grab target.
    expect(browserPanThumbLength({ contentLength: 10_000, overflow: 9_900, trackLength: 300 })).toBe(24);
    expect(browserPanThumbLength({ contentLength: 1440, overflow: 740, trackLength: 0 })).toBe(0);
  });
});
