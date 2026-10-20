import { afterAll, describe, expect, test } from "bun:test";

import type { UiState } from "../src/react-app/shell/ui-state-store";

const PERSISTED_UI_STATE_KEY = "sofia:ui-state:v1";
const originalWindow = globalThis.window;
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

function requireJsonObject(raw: string | null): object {
  expect(raw).not.toBeNull();
  if (raw === null) {
    throw new Error("Expected persisted UI state JSON");
  }

  const parsed: unknown = JSON.parse(raw);
  expect(parsed).not.toBeNull();
  expect(typeof parsed).toBe("object");
  if (parsed === null || typeof parsed !== "object") {
    throw new Error("Expected persisted UI state object");
  }

  return parsed;
}

function objectValue(object: object, key: string): unknown {
  return Object.entries(object).find(([entryKey]) => entryKey === key)?.[1];
}

const storage = memoryStorage();
storage.setItem(
  PERSISTED_UI_STATE_KEY,
  JSON.stringify({ sidePanelState: { ses_1: "extensions" }, sidePanelExpandedState: { ses_1: true, ses_2: false }, workspaceRightSidebarExpanded: true }),
);

Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: {
    document: { cookie: "" },
    localStorage: storage,
  },
});
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: storage,
});

const { persistUiState, toggleSidePanelState, useUiStateStore } = await import(
  "../src/react-app/shell/ui-state-store"
);
const { usePanelTabStore } = await import("../src/react-app/domains/session/panel/panel-tab-store");

const importedSidePanelState = useUiStateStore.getState().sidePanelState;
const importedSidePanelExpandedState = useUiStateStore.getState().sidePanelExpandedState;
const importedWorkspaceRightSidebarExpanded = useUiStateStore.getState().workspaceRightSidebarExpanded;

afterAll(() => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: originalWindow,
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: originalLocalStorage,
  });
});

describe("ui state store", () => {
  test("persists per-session panel visibility and expansion with UI layout", () => {
    const state: UiState = {
      sidebarOpen: true,
      sidePanelState: { ses_1: "extensions" },
      sidePanelExpandedState: { ses_1: true, ses_2: false },
      applicationMenuVisible: false,
      workspaceLeftSidebarWidth: 260,
      workspaceLeftSidebarResizing: false,
      workspaceRightSidebarExpanded: true,
      workspaceRightSidebarExpandedWidth: 520,
    };

    persistUiState(state);

    const parsed = requireJsonObject(storage.getItem(PERSISTED_UI_STATE_KEY));
    expect(objectValue(parsed, "sidePanelState")).toEqual({ ses_1: "extensions" });
    expect(objectValue(parsed, "sidePanelExpandedState")).toEqual({ ses_1: true, ses_2: false });
    expect(objectValue(parsed, "workspaceRightSidebarExpanded")).toBe(true);
    expect(objectValue(parsed, "workspaceRightSidebarExpandedWidth")).toBe(520);
  });

  test("restores persisted per-session panel state on startup", () => {
    expect(importedSidePanelState).toEqual({ ses_1: "extensions" });
    expect(importedSidePanelExpandedState).toEqual({ ses_1: true, ses_2: false });
    expect(importedWorkspaceRightSidebarExpanded).toBe(true);
  });

  test("toggles per-session panel visibility", () => {
    const state: UiState = {
      sidebarOpen: true,
      sidePanelState: {},
      sidePanelExpandedState: {},
      applicationMenuVisible: false,
      workspaceLeftSidebarWidth: 260,
      workspaceLeftSidebarResizing: false,
      workspaceRightSidebarExpanded: false,
      workspaceRightSidebarExpandedWidth: 520,
    };

    const opened = toggleSidePanelState(state, "ses_1", "extensions");
    expect(opened.sidePanelState).toEqual({ ses_1: "extensions" });

    const closed = toggleSidePanelState(opened, "ses_1", "extensions");
    expect(closed.sidePanelState).toEqual({ ses_1: null });
  });

  test("preserves active panel content while the panel closes and reopens", () => {
    usePanelTabStore.getState().openTab("ses_preserve", {
      id: "file:report.md",
      type: "artifact",
      label: "report.md",
      preview: "markdown",
    });

    const closed = toggleSidePanelState({
      ...useUiStateStore.getState(),
      sidePanelState: { ses_preserve: "panel" },
    }, "ses_preserve", "panel");
    const reopened = toggleSidePanelState(closed, "ses_preserve", "panel");

    expect(reopened.sidePanelState.ses_preserve).toBe("panel");
    expect(usePanelTabStore.getState().sessions.ses_preserve?.activeTabId).toBe("file:report.md");
    usePanelTabStore.getState().clearSession("ses_preserve");
  });
});
