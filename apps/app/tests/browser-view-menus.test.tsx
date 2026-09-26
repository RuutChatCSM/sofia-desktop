import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  BrowserViewportPalette,
  BrowserZoomPalette,
} from "../src/react-app/domains/session/panel/browser-view-menus";

/**
 * The browser's pickers must be inline rows, never popups: the page is a native
 * `WebContentsView` painted above this DOM, so a popup is either hidden behind
 * the page or forces the page to be detached (which blanks the browser).
 */
describe("browser view palettes", () => {
  test("renders the viewport choices inline", () => {
    const html = renderToStaticMarkup(
      <BrowserViewportPalette viewport={{ mode: "panel" }} onSelect={() => {}} />,
    );

    expect(html).toContain('data-testid="browser-viewport-palette"');
    expect(html).toContain("Panel");
    expect(html).toContain("1440×900");
    expect(html).toContain("390×844");
    expect(html).toContain("Custom");
    expect(html).not.toContain('role="menu"');
    expect(html).not.toContain('role="dialog"');
  });

  test("renders the zoom choices inline with the derived fit scale", () => {
    const html = renderToStaticMarkup(
      <BrowserZoomPalette zoom={{ mode: "fit" }} appliedScale={0.61} onSelect={() => {}} />,
    );

    expect(html).toContain('data-testid="browser-zoom-palette"');
    expect(html).toContain("Fit");
    expect(html).toContain("61%");
    expect(html).toContain("Actual size");
    expect(html).toContain("150%");
    expect(html).not.toContain('role="menu"');
  });

  test("reveals the custom size inputs for a non-preset viewport", () => {
    const html = renderToStaticMarkup(
      <BrowserViewportPalette
        viewport={{ mode: "responsive", width: 1366, height: 768, deviceScaleFactor: 1 }}
        onSelect={() => {}}
      />,
    );

    expect(html).toContain('data-testid="browser-viewport-width"');
    expect(html).toContain('data-testid="browser-viewport-apply"');
    expect(html).toContain("1366");
  });
});
