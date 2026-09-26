import { afterAll, describe, expect, test } from "bun:test";

import { isRecord, mergeBrowserTabNavigation } from "../src/app/lib/browser-tab-state";
import type { BrowserAnnotation, BrowserPanelTab, BrowserTabSyncState } from "../src/app/lib/desktop-types";

const PERSISTED_KEY_V1 = "sofia:panel-tabs:v1";
const PERSISTED_KEY_V2 = "sofia:panel-tabs:v2";

const originalLocalStorage = globalThis.localStorage;

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      return map.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(map.keys())[index] ?? null;
    },
    removeItem(key: string) {
      map.delete(key);
    },
    setItem(key: string, value: string) {
      map.set(key, value);
    },
  };
}

const storage = memoryStorage();

// Seeded before import: the store migrates a v1 blob during module evaluation.
storage.setItem(PERSISTED_KEY_V1, JSON.stringify({
  state: {
    sessions: {
      ses_legacy: {
        tabs: [
          { id: "tab_legacy_1", type: "browser" },
          { id: "tab_legacy_2", type: "browser" },
        ],
        activeTabId: "tab_legacy_2",
      },
    },
  },
  version: 0,
}));

globalThis.localStorage = storage;

const {
  LEGACY_PANEL_TAB_STORE_KEY,
  PERSISTED_PANEL_TAB_STORE_KEY,
  migrateLegacyPanelTabSessions,
  usePanelTabStore,
} = await import("../src/react-app/domains/session/panel/panel-tab-store");

afterAll(() => {
  globalThis.localStorage = originalLocalStorage;
});

function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error("Expected an object");
  }

  return value;
}

function persistedBrowserTab(sessionId: string, tabId: string): Record<string, unknown> {
  const envelope = requireRecord(JSON.parse(storage.getItem(PERSISTED_PANEL_TAB_STORE_KEY) ?? "null"));
  const state = requireRecord(envelope.state);
  const sessions = requireRecord(state.sessions);
  const session = requireRecord(sessions[sessionId]);
  const tabs = session.tabs;

  if (!Array.isArray(tabs)) {
    throw new Error("Expected persisted tabs to be an array");
  }

  const tab = tabs.map(requireRecord).find((entry) => entry.id === tabId);

  if (!tab) {
    throw new Error(`Expected persisted browser tab ${tabId}`);
  }

  return tab;
}

function browserTab(sessionId: string, tabId: string): BrowserPanelTab {
  const tab = usePanelTabStore
    .getState()
    .sessions[sessionId]
    ?.tabs
    .find((entry) => entry.id === tabId);

  if (!tab || tab.type !== "browser") {
    throw new Error(`Expected in-memory browser tab ${tabId}`);
  }

  return tab;
}

function navigation(
  id: string,
  overrides: Partial<BrowserTabSyncState> = {},
): BrowserTabSyncState {
  return {
    id,
    type: "browser",
    label: `Tab ${id}`,
    url: `http://localhost:3000/${id}`,
    favicon: null,
    canGoBack: false,
    canGoForward: false,
    pageState: { status: "ready" },
    agentState: { status: "detached" },
    ...overrides,
  };
}

describe("panel tab storage migration", () => {
  test("carries v1 browser tabs into v2 with durable defaults", () => {
    expect(PERSISTED_PANEL_TAB_STORE_KEY).toBe(PERSISTED_KEY_V2);
    expect(LEGACY_PANEL_TAB_STORE_KEY).toBe(PERSISTED_KEY_V1);
    expect(storage.getItem(PERSISTED_KEY_V1)).toBeNull();

    const session = usePanelTabStore.getState().sessions.ses_legacy;
    expect(session?.tabs.map((tab) => tab.id)).toEqual(["tab_legacy_1", "tab_legacy_2"]);
    expect(session?.activeTabId).toBe("tab_legacy_2");

    const tab = browserTab("ses_legacy", "tab_legacy_1");
    expect(tab.viewport).toEqual({ mode: "panel" });
    expect(tab.zoom).toEqual({ mode: "fit" });
    expect(tab.interactionMode).toBe("browse");
    expect(tab.annotations).toEqual([]);
    expect(tab.pageState).toEqual({ status: "idle" });
    expect(tab.agentState).toEqual({ status: "detached" });
  });

  test("tolerates a legacy blob with no browser tabs", () => {
    expect(migrateLegacyPanelTabSessions({ state: { sessions: { ses_x: { tabs: [{ id: "a", type: "artifact" }] } } } }))
      .toEqual({ sessions: { ses_x: { tabs: [], activeTabId: null } } });
    expect(migrateLegacyPanelTabSessions(undefined)).toEqual({ sessions: {} });
  });
});

describe("browser tab state ownership", () => {
  test("native navigation sync never wipes user-owned state", () => {
    usePanelTabStore.getState().syncBrowserTabs("ses_sync", [navigation("tab_sync")], "tab_sync");

    usePanelTabStore.getState().setBrowserViewport("ses_sync", "tab_sync", {
      mode: "responsive",
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
    });
    usePanelTabStore.getState().setBrowserZoom("ses_sync", "tab_sync", { mode: "custom", scale: 0.75 });
    usePanelTabStore.getState().setBrowserInteractionMode("ses_sync", "tab_sync", "annotate");

    usePanelTabStore.getState().syncBrowserTabs(
      "ses_sync",
      [navigation("tab_sync", { label: "Dashboard", favicon: "icon.png", canGoBack: true })],
      "tab_sync",
    );

    const after = browserTab("ses_sync", "tab_sync");
    expect(after.label).toBe("Dashboard");
    expect(after.favicon).toBe("icon.png");
    expect(after.canGoBack).toBe(true);
    expect(after.viewport).toEqual({ mode: "responsive", width: 1440, height: 900, deviceScaleFactor: 1 });
    expect(after.zoom).toEqual({ mode: "custom", scale: 0.75 });
    expect(after.interactionMode).toBe("annotate");
  });

  test("merge keeps annotations while navigation and health change", () => {
    const annotation: BrowserAnnotation = {
      id: "note_1",
      page: { url: "http://localhost:3000/pricing", pathname: "/pricing" },
      target: {
        type: "element",
        boundingBox: { x: 1, y: 2, width: 3, height: 4 },
        selector: "button.cta.primary",
        text: "Start free",
        role: "button",
      },
      comment: "Too much padding",
      createdAt: 1,
      status: "draft",
    };
    const durable: BrowserPanelTab = {
      ...browserTab("ses_sync", "tab_sync"),
      annotations: [annotation],
      scroll: { x: 0, y: 5831 },
    };

    const merged = mergeBrowserTabNavigation(durable, navigation("tab_sync", {
      label: "Pricing",
      url: "http://localhost:3000/pricing",
      canGoForward: true,
      pageState: { status: "ready" },
      agentState: { status: "attached" },
    }));

    expect(merged.annotations).toEqual([annotation]);
    expect(merged.scroll).toEqual({ x: 0, y: 5831 });
    expect(merged.viewport).toEqual(durable.viewport);
    expect(merged.zoom).toEqual(durable.zoom);
    expect(merged.interactionMode).toBe(durable.interactionMode);
    expect(merged.label).toBe("Pricing");
    expect(merged.canGoForward).toBe(true);
    expect(merged.agentState).toEqual({ status: "attached" });
  });

  test("each tab keeps its own viewport across switches", () => {
    usePanelTabStore.getState().syncBrowserTabs("ses_multi", [navigation("tab_wide"), navigation("tab_phone")], "tab_wide");

    usePanelTabStore.getState().setBrowserViewport("ses_multi", "tab_wide", {
      mode: "responsive",
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
    });
    usePanelTabStore.getState().setBrowserViewport("ses_multi", "tab_phone", {
      mode: "responsive",
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
    });

    for (const tabId of ["tab_wide", "tab_phone", "tab_wide"]) {
      usePanelTabStore.getState().selectTab("ses_multi", tabId);
    }

    expect(browserTab("ses_multi", "tab_wide").viewport).toMatchObject({ width: 1440, height: 900 });
    expect(browserTab("ses_multi", "tab_phone").viewport).toMatchObject({ width: 390, height: 844 });
  });

  test("agent failure and page failure stay in separate health domains", () => {
    usePanelTabStore.getState().syncBrowserTabs("ses_health", [navigation("tab_health")], "tab_health");
    usePanelTabStore.getState().setBrowserViewport("ses_health", "tab_health", {
      mode: "responsive",
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
    });

    const error = { message: "CDP connection closed", at: 42 };
    usePanelTabStore.getState().syncBrowserTabs(
      "ses_health",
      [navigation("tab_health", { agentState: { status: "error", error } })],
      "tab_health",
    );

    const failedAgent = browserTab("ses_health", "tab_health");
    expect(failedAgent.agentState).toEqual({ status: "error", error });
    expect(failedAgent.pageState).toEqual({ status: "ready" });
    expect(failedAgent.viewport).toMatchObject({ width: 1440, height: 900 });

    const pageError = { code: -102, description: "ERR_CONNECTION_REFUSED", url: "http://localhost:3000" };
    usePanelTabStore.getState().syncBrowserTabs(
      "ses_health",
      [navigation("tab_health", { pageState: { status: "error", error: pageError } })],
      "tab_health",
    );

    const failedPage = browserTab("ses_health", "tab_health");
    expect(failedPage.pageState).toEqual({ status: "error", error: pageError });
    expect(failedPage.agentState).toEqual({ status: "detached" });
    expect(failedPage.viewport).toMatchObject({ width: 1440, height: 900 });
  });
});

describe("browser tab persistence", () => {
  test("persists durable user state but never agent or page health", () => {
    usePanelTabStore.getState().syncBrowserTabs("ses_persist", [navigation("tab_persist")], "tab_persist");
    usePanelTabStore.getState().setBrowserViewport("ses_persist", "tab_persist", {
      mode: "responsive",
      width: 1280,
      height: 800,
      deviceScaleFactor: 2,
    });
    usePanelTabStore.getState().setBrowserZoom("ses_persist", "tab_persist", { mode: "actual" });
    usePanelTabStore.getState().setBrowserInteractionMode("ses_persist", "tab_persist", "annotate");
    usePanelTabStore.getState().syncBrowserTabs(
      "ses_persist",
      [navigation("tab_persist", { agentState: { status: "attached" } })],
      "tab_persist",
    );

    const persisted = persistedBrowserTab("ses_persist", "tab_persist");

    // Exactly the durable record: no navigation, no health, no lease.
    expect(Object.keys(persisted).sort()).toEqual([
      "annotations",
      "id",
      "interactionMode",
      "scroll",
      "type",
      "viewport",
      "zoom",
    ]);
    expect(persisted.viewport).toEqual({ mode: "responsive", width: 1280, height: 800, deviceScaleFactor: 2 });
    expect(persisted.zoom).toEqual({ mode: "actual" });
    expect(persisted.interactionMode).toBe("annotate");
    expect(persisted.annotations).toEqual([]);

    // Agent leases die with the process; health is re-derived by Electron.
    expect("agentState" in persisted).toBe(false);
    expect("pageState" in persisted).toBe(false);
    expect("canGoBack" in persisted).toBe(false);
    expect("leaseId" in persisted).toBe(false);
  });

  test("fit carries no stored scale to go stale on another monitor", () => {
    usePanelTabStore.getState().syncBrowserTabs("ses_fit", [navigation("tab_fit")], "tab_fit");
    usePanelTabStore.getState().setBrowserZoom("ses_fit", "tab_fit", { mode: "custom", scale: 0.42 });
    usePanelTabStore.getState().setBrowserZoom("ses_fit", "tab_fit", { mode: "fit" });

    expect(browserTab("ses_fit", "tab_fit").zoom).toEqual({ mode: "fit" });
    expect(persistedBrowserTab("ses_fit", "tab_fit").zoom).toEqual({ mode: "fit" });
  });
});
