// Browser presentation policy.
//
// How the browser is shown to the user is a *policy* decision, separate from
// every other browser axis:
//
//   tab state          URL, viewport, zoom, scroll, annotations
//   page state         loading / ready / error
//   agent state        detached / active / paused
//   presentation       hidden / peek / docked / expanded   <- this module
//
// None of those owns another. The agent can create browser *activity*; only
// this policy decides what (if anything) the user sees. Nothing here ever
// writes to `BrowserPanelTab.viewport`, and nothing here reuses or releases an
// agent lease.
//
// Durable pieces (autoShow, dockedWidth) persist. Live pieces (current mode,
// suppression, attention, restore target) do not: restarting the app must never
// resurrect a transient presentation state.
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import type { BrowserPresentationMode, BrowserViewport } from "../../../../app/lib/desktop-types";

export const PERSISTED_BROWSER_PRESENTATION_KEY = "sofia:browser-presentation:v1";

export type { BrowserPresentationMode };

export type BrowserAutoShow = "always" | "attention" | "never";

export type BrowserAttentionReason =
  | "authentication"
  | "permission"
  | "confirmation"
  | "captcha"
  | "agent-control-error";

export type BrowserAttentionRequest = {
  reason: BrowserAttentionReason;
  url: string;
  host: string;
  at: number;
};

export type BrowserPresentationPreferences = {
  autoShow: BrowserAutoShow;
  /** The user's preferred docked width, not necessarily the achievable one. */
  dockedWidth: number;
};

/** Where `Restore` returns to after an expanded presentation. */
export type BrowserRestorePresentation =
  | { mode: "hidden" }
  | { mode: "peek" }
  | { mode: "docked"; width: number };

export type BrowserPresentationRuntime = {
  mode: BrowserPresentationMode;
  restore: BrowserRestorePresentation | null;
  /** The user hid the preview during this task; ordinary agent activity stays hidden. */
  peekSuppressed: boolean;
  attention: BrowserAttentionRequest | null;
  /**
   * Where the user last dragged the preview, relative to the workspace it
   * floats over. Session-scoped on purpose: a different task gets a different
   * layout, so the default top-right resting place is the right answer there.
   */
  peekPosition: BrowserPeekPosition | null;
};

export type BrowserPresentationState = {
  preferences: BrowserPresentationPreferences;
  runtime: BrowserPresentationRuntime;
};

export type BrowserPresentationEvent =
  | { type: "agent-browser-started" }
  | { type: "user-open-browser" }
  | { type: "user-hide-peek" }
  | { type: "user-dock-browser"; width?: number }
  | { type: "user-expand-browser" }
  | { type: "user-restore-browser" }
  | { type: "attention-required"; reason: BrowserAttentionReason; url: string }
  | { type: "user-move-peek"; position: BrowserPeekPosition }
  | { type: "attention-resolved" }
  | { type: "last-browser-tab-closed" }
  | { type: "session-changed" }
  | { type: "preference-auto-show"; value: BrowserAutoShow }
  | { type: "preference-docked-width"; value: number };

export const DEFAULT_BROWSER_AUTO_SHOW: BrowserAutoShow = "always";
export const DEFAULT_BROWSER_DOCKED_WIDTH = 520;
export const MIN_BROWSER_DOCKED_WIDTH = 320;
export const MAX_BROWSER_DOCKED_WIDTH = 1600;

/**
 * A small floating preview must not turn the page mobile, so Peek renders a
 * normal desktop breakpoint scaled into the card. The panel achieves that with
 * page *zoom* rather than with a virtual screen: a virtual screen is painted by
 * the native view, and a card cannot clip a native surface. This layout is
 * presentation-derived and is never written back into `BrowserPanelTab.viewport`
 * or `BrowserPanelTab.zoom`.
 */
export const BROWSER_PEEK_VIEWPORT = {
  mode: "responsive",
  width: 1280,
  height: 800,
  deviceScaleFactor: 1,
} as const;

/**
 * Peek geometry belongs to the presentation, not to whatever the page is doing.
 * A navigation, a tab switch or a title change can never resize the card,
 * because nothing derives its size from page state. The one thing the card does
 * follow is the shape of the content it holds: a card that is not the shape of
 * its page is a card with dead space in it.
 */
export const BROWSER_PEEK_WIDTH = 440;
export const BROWSER_PEEK_ASPECT = 16 / 10;
export const BROWSER_PEEK_HEIGHT = Math.round(BROWSER_PEEK_WIDTH / BROWSER_PEEK_ASPECT);
/**
 * The largest card Peek will ask for, in each direction independently: enough
 * for a desktop page at the default width, and enough for a tablet in portrait.
 */
export const MAX_BROWSER_PEEK_WIDTH = BROWSER_PEEK_WIDTH;
export const MAX_BROWSER_PEEK_HEIGHT = 560;
/** …and the smallest, so a hug never leaves an unreadable or hard-to-grab card. */
export const MIN_BROWSER_PEEK_WIDTH = 200;
export const MIN_BROWSER_PEEK_HEIGHT = 150;
export const BROWSER_PEEK_RADIUS = 12;
/** The card never comes closer than this to the edges of the workspace it floats over. */
export const BROWSER_PEEK_MARGIN = 16;
// Resting place before the user drags the card: clear of the workspace header
// and of the right edge it sits near.
export const BROWSER_PEEK_DEFAULT_TOP = 64;
export const BROWSER_PEEK_DEFAULT_RIGHT = 20;

/** Expanded gives the browser the dominant share of the workspace, never all of it. */
export const BROWSER_EXPANDED_WIDTH_RATIO = 0.6;
export const MIN_BROWSER_EXPANDED_WIDTH = 720;
export const MAX_BROWSER_EXPANDED_WIDTH = 1100;

export type BrowserPeekPosition = { x: number; y: number };

export const BROWSER_PEEK_DRAG_THRESHOLD_PX = 5;

/**
 * One pointer gesture on the card. It stays a click until the pointer has
 * really travelled, so a slightly imprecise click opens the browser instead of
 * nudging the card by a pixel.
 */
export type BrowserPeekDragState = {
  /** Where the card sat when the pointer went down. */
  origin: BrowserPeekPosition;
  dx: number;
  dy: number;
  dragging: boolean;
};

export function beginPeekDrag(origin: BrowserPeekPosition): BrowserPeekDragState {
  return { origin, dx: 0, dy: 0, dragging: false };
}

export function movePeekDrag(
  state: BrowserPeekDragState,
  dx: number,
  dy: number,
): BrowserPeekDragState {
  const dragging = state.dragging || Math.hypot(dx, dy) >= BROWSER_PEEK_DRAG_THRESHOLD_PX;
  return { ...state, dx, dy, dragging };
}

/** Live card position during a drag, clamped to the workspace on every frame. */
export function peekDragPosition(
  state: BrowserPeekDragState,
  surface: BrowserSurfaceSize,
): BrowserPeekPosition {
  // Below the threshold the card does not move at all: an imprecise click must
  // not nudge it, because that same gesture is also how the browser opens.
  if (!state.dragging) return state.origin;
  return clampPeekPosition({ x: state.origin.x + state.dx, y: state.origin.y + state.dy }, surface);
}

/** The workspace the card floats over, in CSS pixels. */
export type BrowserSurfaceSize = { width: number; height: number };

export function createBrowserPresentationState(
  preferences: Partial<BrowserPresentationPreferences> = {},
): BrowserPresentationState {
  return {
    preferences: {
      autoShow: preferences.autoShow ?? DEFAULT_BROWSER_AUTO_SHOW,
      dockedWidth: clampDockedWidth(preferences.dockedWidth ?? DEFAULT_BROWSER_DOCKED_WIDTH),
    },
    runtime: {
      mode: "hidden",
      restore: null,
      peekSuppressed: false,
      attention: null,
      peekPosition: null,
    },
  };
}

export function clampDockedWidth(width: number): number {
  const numeric = Number(width);
  if (!Number.isFinite(numeric) || numeric <= 0) return DEFAULT_BROWSER_DOCKED_WIDTH;
  return Math.min(Math.max(Math.round(numeric), MIN_BROWSER_DOCKED_WIDTH), MAX_BROWSER_DOCKED_WIDTH);
}

/**
 * The viewport a tab renders at while it is Peek-ed. Mirrors the desktop rule:
 * an explicit responsive preset always wins, and a `panel` tab gets a normal
 * desktop breakpoint so a small card cannot make the page render as a phone.
 */
export function browserPeekViewport(tabViewport?: BrowserViewport | null) {
  if (tabViewport && tabViewport.mode === "responsive") {
    return { width: tabViewport.width, height: tabViewport.height };
  }
  return { width: BROWSER_PEEK_VIEWPORT.width, height: BROWSER_PEEK_VIEWPORT.height };
}

/**
 * The one rectangle the floating preview ever occupies — the card hugs the
 * content it holds.
 *
 * The card is contained in the default footprint box at the content's *exact*
 * aspect, then grown to a floor on both axes so a hug can never produce an
 * unreadable sliver. Containing at the content's own aspect is the whole point:
 * a 16:10 panel tab, a 390×844 phone preset and anything in between each get a
 * card of their own shape, and the page fills every pixel of it — no letterbox,
 * no dead strip, nothing to hide behind the card's frame.
 *
 * Only the shape of the content is read, and only the *viewport* — never the
 * page, its title, its URL or its health, so nothing a navigation does can
 * resize a card the user is looking at.
 */
export function browserPeekSize(tabViewport?: BrowserViewport | null) {
  const viewport = browserPeekViewport(tabViewport);
  const contained = Math.min(
    MAX_BROWSER_PEEK_WIDTH / viewport.width,
    MAX_BROWSER_PEEK_HEIGHT / viewport.height,
  );
  const floor = Math.max(
    MIN_BROWSER_PEEK_WIDTH / (viewport.width * contained),
    MIN_BROWSER_PEEK_HEIGHT / (viewport.height * contained),
    1,
  );
  return {
    width: Math.round(viewport.width * contained * floor),
    height: Math.round(viewport.height * contained * floor),
  };
}

/** Top-right resting place, used until the user drags the card somewhere else. */
export function defaultPeekPosition(
  surface: BrowserSurfaceSize,
  size = browserPeekSize(),
): BrowserPeekPosition {
  return clampPeekPosition(
    {
      x: surface.width - size.width - BROWSER_PEEK_DEFAULT_RIGHT,
      y: BROWSER_PEEK_DEFAULT_TOP,
    },
    surface,
    size,
  );
}

/**
 * Keep the whole card inside the workspace it floats over. Every workspace
 * resize re-runs this against the last known position, so a sidebar change or
 * a window shrink can never strand the card half off-screen.
 */
export function clampPeekPosition(
  position: BrowserPeekPosition,
  surface: BrowserSurfaceSize,
  size = browserPeekSize(),
): BrowserPeekPosition {
  const maxX = Math.max(BROWSER_PEEK_MARGIN, surface.width - size.width - BROWSER_PEEK_MARGIN);
  const maxY = Math.max(BROWSER_PEEK_MARGIN, surface.height - size.height - BROWSER_PEEK_MARGIN);
  return {
    x: Math.round(Math.min(Math.max(position.x, BROWSER_PEEK_MARGIN), maxX)),
    y: Math.round(Math.min(Math.max(position.y, BROWSER_PEEK_MARGIN), maxY)),
  };
}

/** Expanded browser width for a workspace of `availableWidth` pixels. */
export function browserExpandedWidth(availableWidth: number): number {
  const available =
    Number.isFinite(availableWidth) && availableWidth > 0 ? availableWidth : MIN_BROWSER_EXPANDED_WIDTH;
  return Math.round(
    Math.min(
      Math.max(available * BROWSER_EXPANDED_WIDTH_RATIO, MIN_BROWSER_EXPANDED_WIDTH),
      MAX_BROWSER_EXPANDED_WIDTH,
    ),
  );
}

export function browserAttentionHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Whether the presentation puts a browser surface in front of the user at all. */
export function browserPresentationVisible(mode: BrowserPresentationMode): boolean {
  return mode !== "hidden";
}

function currentRestore(state: BrowserPresentationState): BrowserRestorePresentation {
  const mode = state.runtime.mode;
  if (mode === "docked") return { mode: "docked", width: state.preferences.dockedWidth };
  if (mode === "peek") return { mode: "peek" };
  return { mode: "hidden" };
}

/**
 * The single decision point for how — or whether — the user sees browser
 * activity. Pure and deterministic so the policy is unit-testable instead of
 * being spread across React effects.
 */
export function reduceBrowserPresentation(
  state: BrowserPresentationState,
  event: BrowserPresentationEvent,
): BrowserPresentationState {
  const { preferences, runtime } = state;

  switch (event.type) {
    case "agent-browser-started": {
      // Ordinary agent activity. An explicit Hide or an off switch wins, and
      // anything already on screen stays exactly as the user left it.
      if (runtime.peekSuppressed || runtime.mode !== "hidden" || preferences.autoShow !== "always") {
        return state;
      }
      return { ...state, runtime: { ...runtime, mode: "peek" } };
    }
    case "user-open-browser":
      return {
        ...state,
        runtime: { ...runtime, mode: "peek", peekSuppressed: false },
      };
    case "user-dock-browser":
      return {
        ...state,
        preferences: {
          ...preferences,
          dockedWidth: clampDockedWidth(event.width ?? preferences.dockedWidth),
        },
        runtime: { ...runtime, mode: "docked", restore: null, peekSuppressed: false },
      };
    case "user-expand-browser": {
      if (runtime.mode === "expanded") return state;
      return {
        ...state,
        runtime: { ...runtime, mode: "expanded", restore: currentRestore(state) },
      };
    }
    case "user-restore-browser": {
      if (runtime.mode !== "expanded") return state;
      const restore = runtime.restore;
      if (!restore) return { ...state, runtime: { ...runtime, mode: "docked", restore: null } };
      if (restore.mode === "docked") {
        return {
          ...state,
          preferences: { ...preferences, dockedWidth: clampDockedWidth(restore.width) },
          runtime: { ...runtime, mode: "docked", restore: null },
        };
      }
      return { ...state, runtime: { ...runtime, mode: restore.mode, restore: null } };
    }
    case "user-hide-peek":
      // A presentation action: the browser keeps running and the tabs survive.
      return { ...state, runtime: { ...runtime, mode: "hidden", restore: null, peekSuppressed: true } };
    case "attention-required": {
      const attention: BrowserAttentionRequest = {
        reason: event.reason,
        url: event.url,
        host: browserAttentionHost(event.url),
        at: Date.now(),
      };
      const shouldSurface =
        runtime.mode === "hidden" && !runtime.peekSuppressed && preferences.autoShow === "always";
      return {
        ...state,
        runtime: { ...runtime, attention, mode: shouldSurface ? "peek" : runtime.mode },
      };
    }
    case "user-move-peek":
      // Dragging is presentation-only: it moves the card and nothing else.
      return { ...state, runtime: { ...runtime, peekPosition: event.position } };
    case "attention-resolved":
      return runtime.attention ? { ...state, runtime: { ...runtime, attention: null } } : state;
    case "last-browser-tab-closed":
      return {
        ...state,
        runtime: { ...runtime, mode: "hidden", restore: null, attention: null },
      };
    case "session-changed":
      return {
        ...state,
        runtime: { mode: "hidden", restore: null, peekSuppressed: false, attention: null, peekPosition: null },
      };
    case "preference-auto-show":
      return { ...state, preferences: { ...preferences, autoShow: event.value } };
    case "preference-docked-width":
      return { ...state, preferences: { ...preferences, dockedWidth: clampDockedWidth(event.value) } };
    default:
      return state;
  }
}

type BrowserPresentationStore = {
  state: BrowserPresentationState;
  dispatch: (event: BrowserPresentationEvent) => void;
};

export const useBrowserPresentationStore = create<BrowserPresentationStore>()(
  persist(
    (set) => ({
      state: createBrowserPresentationState(),
      dispatch: (event) =>
        set((previous) => ({ state: reduceBrowserPresentation(previous.state, event) })),
    }),
    {
      name: PERSISTED_BROWSER_PRESENTATION_KEY,
      storage: createJSONStorage(() => localStorage),
      // Preferences only: a restart must never reopen into transient UI.
      partialize: (store) => ({ state: { preferences: store.state.preferences } }),
      merge: (persisted, current) => {
        const preferences =
          persisted && typeof persisted === "object"
            ? (persisted as { state?: { preferences?: Partial<BrowserPresentationPreferences> } }).state
                ?.preferences
            : undefined;
        return { ...current, state: createBrowserPresentationState(preferences ?? {}) };
      },
    },
  ),
);

export function dispatchBrowserPresentation(event: BrowserPresentationEvent): void {
  useBrowserPresentationStore.getState().dispatch(event);
}

export function browserPresentationState(): BrowserPresentationState {
  return useBrowserPresentationStore.getState().state;
}
