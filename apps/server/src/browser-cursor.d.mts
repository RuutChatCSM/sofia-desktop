/**
 * Types for `browser-cursor.mjs`.
 *
 * The implementation stays `.mjs` because the desktop CDP broker loads the same
 * overlay script by path, outside any TypeScript build. That leaves a `.ts`
 * consumer with nothing to resolve, so the surface its test uses is declared
 * here rather than by turning on `allowJs` for the whole server package.
 */

export declare const BROWSER_CURSOR_ELEMENT_ID: string;

/** The overlay source, injected as a document script and evaluated on each page. */
export declare const BROWSER_CURSOR_SCRIPT: string;

/** Offset the cursor arrives from, so it glides in rather than appearing. */
export declare const BROWSER_CURSOR_APPROACH: { dx: number; dy: number };

export interface BrowserCursor {
  /** Whether the pointer is claiming a position on this document. */
  isShown(): boolean;
  /** Install the overlay and register it for every document this page loads. */
  ready(): Promise<void>;
  move(x: number, y: number): Promise<void>;
  click(x: number, y: number): Promise<void>;
  doubleClick(x: number, y: number): Promise<void>;
  /** The document is leaving; the next spatial action decides where it appears. */
  fade(): Promise<void>;
  /** For a reconnected document whose overlay state can no longer be trusted. */
  forget(): void;
}

/**
 * Drives the overlay for one page connection. `send` is a CDP
 * `send(method, params)` bound to that page; every call is best-effort, so a
 * cursor that cannot be drawn never fails the action that asked for it.
 */
export declare function createBrowserCursor(options: {
  send(method: string, params?: Record<string, unknown>): unknown;
}): BrowserCursor;
