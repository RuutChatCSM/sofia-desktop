// Type definitions for the desktop bridge.
// The payload shapes and the per-command contract live in
// packages/types/src/desktop-ipc.ts (shared with the Electron main process);
// this module re-exports them as the app-side import path.

import type { WorkspaceWire } from "@sofia/types/workspace";

export type {
  AppBuildInfo,
  BrandIconApplyResult,
  BrandIconState,
  CacheResetResult,
  DesktopBootstrapConfig,
  DesktopDistributionInfo,
  DesktopIntegrationIssue,
  DesktopIntegrationResult,
  DesktopIntegrationStatus,
  DesktopCommandArgs,
  DesktopCommandInvokers,
  DesktopCommandMap,
  DesktopCommandName,
  DesktopCommandResult,
  DesktopFetchInit,
  DesktopFetchResult,
  EngineDoctorResult,
  EngineInfo,
  CodexEngineStatus,
  EvalRelaunchResult,
  ExecResult,
  LocalSkillCard,
  LocalSkillContent,
  NukeManifestPreview,
  NukeOptions,
  NukeReceipt,
  NukeReceiptError,
  WorkspaceEngineCommandDraft,
  WorkspaceEngineExecutionEnvEntry,
  WorkspaceEngineExecutionSnapshot,
  SofiaDockerCleanupResult,
  SofiaServerInfo,
  UpdaterEnvironment,
  WorkspaceCreateInput,
  WorkspaceCreateRemoteInput,
  WorkspaceExportSummary,
  WorkspaceList,
  WorkspaceSofiaConfig,
  WorkspaceUpdateRemoteInput,
} from "@sofia/types/desktop-ipc";

// Canonical wire shape shared with sofia-server and the desktop bridge.
// Single source of truth: packages/types/src/workspace.ts.
export type WorkspaceInfo = WorkspaceWire;

// Browser tab state for the built-in browser panel.
//
// Three state domains are kept apart so each one can only be written by its
// owner:
// - `BrowserTabPersistentState` is user-owned. It survives agent turns and app
//   restarts, and nothing else is allowed to change it.
// - `BrowserTabNavigationState` is the navigation Electron is authoritative for.
// - `BrowserTabRuntimeState` is live health. It is re-derived on every launch and
//   is never persisted.
// `BrowserPanelTab` composes all three. `BrowserTabSyncState` is the only shape
// Electron may send back, so a native or agent-driven update cannot erase user
// visual state even by accident.
export type BrowserRect = { x: number; y: number; width: number; height: number };

export type BrowserViewport =
  | { mode: "panel" }
  | { mode: "responsive"; width: number; height: number; deviceScaleFactor: number };

// `fit` and `actual` carry no number: the effective scale is derived from the
// viewport and the available canvas, so a resized panel (or a different monitor)
// can never resurrect a stale percentage.
export type BrowserZoom =
  | { mode: "fit" }
  | { mode: "actual" }
  | { mode: "custom"; scale: number };

/**
 * How the browser is presented to the user. Presentation is policy: it is a
 * separate axis from a tab's viewport/zoom, from page health, and from agent
 * leases. `peek` renders a `panel` tab at a desktop breakpoint inside a small
 * floating card, which is why the effective viewport is derived, not stored.
 */
export type BrowserPresentationMode = "hidden" | "peek" | "docked" | "expanded";

/**
 * The floating preview's hover chrome.
 *
 * The card is a native page under a native shield, so its title, status and
 * control strip cannot be React. The renderer that owns tab state publishes
 * this descriptor instead, and the shield draws it on hover.
 */
export type BrowserPeekChrome = {
  title: string;
  favicon: string | null;
  /** The agent currently holds a lease on this page. */
  browsing: boolean;
  tabCount: number;
  loading: boolean;
  dark: boolean;
  /** The surface colour painted into the card's native corners. */
  frameColor: string;
  radius: number;
};

/** Pointer motion on the preview, relative to where the drag started. */
export type BrowserPeekPointer = {
  phase: "down" | "move" | "up";
  dx: number;
  dy: number;
};

// Page health and agent health are separate domains on purpose: a page the user
// can still read must never be reported as a browser failure.
export type BrowserPageError = { code: number; description: string; url: string };

export type BrowserPageState = {
  status: "idle" | "loading" | "ready" | "error";
  error?: BrowserPageError;
};

export type BrowserAgentError = { message: string; at: number };

export type BrowserAgentState = {
  status: "detached" | "requesting" | "attached" | "paused" | "error";
  error?: BrowserAgentError;
};

export type BrowserInteractionMode = "browse" | "annotate";

export type BrowserAnnotationTarget =
  | {
      type: "element";
      boundingBox: BrowserRect;
      selector?: string;
      domPath?: string;
      text?: string;
      role?: string;
    }
  | { type: "region"; boundingBox: BrowserRect };

export type BrowserAnnotation = {
  id: string;
  page: { url: string; pathname: string };
  target: BrowserAnnotationTarget;
  comment: string;
  createdAt: number;
  status: "draft" | "attached" | "sent" | "resolved";
};

export type BrowserScroll = { x: number; y: number };

export type BrowserTabId = {
  id: string;
  type: "browser";
};

export type BrowserTabNavigationState = BrowserTabId & {
  label: string;
  url: string;
  favicon: string | null;
  canGoBack: boolean;
  canGoForward: boolean;
};

export type BrowserTabRuntimeState = {
  pageState: BrowserPageState;
  agentState: BrowserAgentState;
  /**
   * What the runtime actually applied, or null in panel mode. Derived from the
   * tab's viewport, zoom, and the available canvas — reported rather than
   * stored, so a resized panel can never resurrect a stale scale, and the
   * pan/overflow the canvas exposes is always the real one.
   */
  appliedViewport: BrowserAppliedViewport | null;
  /**
   * The native rectangle the page is rendered into, in renderer CSS pixels.
   * The browser page is a native view that ignores CSS clipping, so this must
   * always sit inside the canvas rectangle; publishing it makes that an
   * invariant a test can assert instead of a screenshot a reviewer must judge.
   */
  appliedBounds: BrowserRect | null;
};

export type BrowserPanOffset = { x: number; y: number };

export type BrowserAppliedViewport = {
  scale: number;
  /** Current scroll of an overflowing canvas, in canvas pixels. */
  pan: BrowserPanOffset;
  /** How far the canvas can pan, in canvas pixels. Zero when it fits. */
  overflow: BrowserPanOffset;
};

export type BrowserTabPersistentState = {
  viewport: BrowserViewport;
  zoom: BrowserZoom;
  interactionMode: BrowserInteractionMode;
  annotations: BrowserAnnotation[];
  scroll: BrowserScroll | null;
};

/** Everything Electron may report: navigation plus live health. */
export type BrowserTabSyncState = BrowserTabNavigationState & BrowserTabRuntimeState;

export type BrowserPanelTab =
  & BrowserTabNavigationState
  & BrowserTabRuntimeState
  & BrowserTabPersistentState;

export type AgentBrowserCapabilities = {
  dom: boolean;
  screenshots: boolean;
  network: boolean;
  console: boolean;
  input: boolean;
};

export type AgentBrowserLeaseAction = "acquire" | "release" | "pause" | "resume" | "fail";

export type AgentBrowserLeaseRequest = {
  tabId?: string;
  leaseId?: string;
  cdpSessionId?: string | null;
  capabilities?: Partial<AgentBrowserCapabilities>;
  error?: { message: string };
};
