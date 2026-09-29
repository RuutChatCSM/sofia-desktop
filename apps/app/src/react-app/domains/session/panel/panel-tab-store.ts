import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { isCollectibleArtifactTarget, type OpenTarget, type OpenTargetPreview } from "../artifacts/open-target";
import {
  createBrowserPanelTab,
  isRecord,
  isSameBrowserPanelTab,
  mergeBrowserTabNavigation,
  normalizeBrowserAnnotations,
  normalizeBrowserInteractionMode,
  normalizeBrowserScroll,
  normalizeBrowserViewport,
  normalizeBrowserZoom,
} from "../../../../app/lib/browser-tab-state";

// v2 persists the durable, user-owned part of a browser tab (viewport, zoom,
// interaction mode, annotations). Navigation and health stay with Electron and
// agent leases are never persisted at all.
export const PERSISTED_PANEL_TAB_STORE_KEY = "sofia:panel-tabs:v2";
export const LEGACY_PANEL_TAB_STORE_KEY = "sofia:panel-tabs:v1";

export type PanelTabType = "artifact" | "browser" | "changes" | "start" | "files";

export type { BrowserPanelTab } from "../../../../app/lib/desktop-types";
import type {
  BrowserAnnotation,
  BrowserInteractionMode,
  BrowserPanelTab,
  BrowserTabId,
  BrowserTabPersistentState,
  BrowserTabSyncState,
  BrowserViewport,
  BrowserZoom,
} from "../../../../app/lib/desktop-types";

export type ArtifactPanelTab = {
  id: string;
  type: "artifact";
  label: string;
  preview: OpenTargetPreview;
}

/**
 * A review workspace tab. It carries the *immutable* change set id it reviews, so
 * a tab opened from an old turn keeps showing that turn's patch — never whatever
 * is dirty in the repository now. Changes tabs are not persisted (only browser
 * tabs are), so a reload does not resurrect a stale review.
 */
export type ChangesPanelTab = {
  id: string;
  type: "changes";
  label: string;
  changeSetId: string;
  /** The file to select when the pane opens (a row click, not just Review). */
  filePath?: string;
};

export type PanelTab = BrowserPanelTab | ArtifactPanelTab | ChangesPanelTab | { id: string; type: "start" | "files"; label: string; path?: string };

export type SessionPanelState = {
  tabs: PanelTab[];
  activeTabId: string | null;
};

// Persistence stores the tab identity plus the user-owned slice only. Runtime
// health lives in the same object in memory and cannot end up in storage,
// because the writer below does not accept it.
type PersistedBrowserTabState = BrowserTabId & BrowserTabPersistentState;

type PersistedSessionPanelState = {
  tabs: PersistedBrowserTabState[];
  activeTabId: string | null;
};

type PersistedPanelTabStore = {
  sessions: Record<string, PersistedSessionPanelState>;
};

export type PanelTabStore = {
  sessions: Record<string, SessionPanelState>;
  transcriptArtifactTargets: Record<string, OpenTarget[]>;
  openTab: (sessionId: string, tab: PanelTab) => void;
  closeTab: (sessionId: string, tabId: string) => void;
  selectTab: (sessionId: string, tabId: string) => void;
  reorderTabs: (sessionId: string, tabIds: string[]) => void;
  syncBrowserTabs: (
    sessionId: string,
    browserTabs: BrowserTabSyncState[],
    activeBrowserTabId: string | null,
  ) => void;
  setBrowserViewport: (sessionId: string, tabId: string, viewport: BrowserViewport) => void;
  setBrowserZoom: (sessionId: string, tabId: string, zoom: BrowserZoom) => void;
  setBrowserInteractionMode: (sessionId: string, tabId: string, mode: BrowserInteractionMode) => void;
  addBrowserAnnotation: (sessionId: string, tabId: string, annotation: BrowserAnnotation) => void;
  syncArtifactTargets: (
    sessionId: string,
    targets: Array<{ id: string; name: string; preview: OpenTargetPreview }>,
  ) => void;
  syncTranscriptArtifacts: (sessionId: string, targets: OpenTarget[]) => void;
  clearSession: (sessionId: string) => void;
};

const EMPTY_SESSION: SessionPanelState = {
  tabs: [],
  activeTabId: null,
};

function getWritableSession(state: PanelTabStore, sessionId: string): SessionPanelState {
  return state.sessions[sessionId] ?? EMPTY_SESSION;
}

function updateSession(
  state: PanelTabStore,
  sessionId: string,
  session: SessionPanelState,
): Partial<PanelTabStore> {
  return {
    sessions: {
      ...state.sessions,
      [sessionId]: session,
    },
  };
}

/**
 * Field-level update for one browser tab. Panel bounds, page viewport, and zoom
 * are separate user intents, so nothing here ever changes them together.
 */
function updateBrowserTab(
  state: PanelTabStore,
  sessionId: string,
  tabId: string,
  update: (tab: BrowserPanelTab) => BrowserPanelTab,
): PanelTabStore | Partial<PanelTabStore> {
  const session = getWritableSession(state, sessionId);
  const index = session.tabs.findIndex((tab) => tab.id === tabId && tab.type === "browser");

  if (index < 0) {
    return state;
  }

  const tab = session.tabs[index];

  if (tab.type !== "browser") {
    return state;
  }

  const nextTab = update(tab);

  if (isSameBrowserPanelTab(tab, nextTab)) {
    return state;
  }

  const tabs = [...session.tabs];
  tabs[index] = nextTab;

  return updateSession(state, sessionId, { ...session, tabs });
}

function reconcileOpenArtifactTabs(
  session: SessionPanelState,
  targets: Array<{ id: string; name: string; preview: OpenTargetPreview }>,
): SessionPanelState {
  const targetMap = new Map(targets.map((target) => [target.id, target]));

  const tabs = session.tabs
    .map((tab) => {
      if (tab.type !== "artifact") {
        return tab;
      }

      const target = targetMap.get(tab.id);

      if (!target) {
        return null;
      }

      return {
        ...tab,
        label: target.name,
        preview: target.preview,
      };
    })
    .filter((tab): tab is PanelTab => tab !== null);

  return {
    tabs,
    activeTabId: resolveActiveTabId(tabs, session.activeTabId),
  };
}

function isSameTranscriptArtifactTargets(left: OpenTarget[], right: OpenTarget[]) {
  return (
    left.length === right.length &&
    left.every((target, index) => {
      const other = right[index];
      return other && target.id === other.id && target.updatedAt === other.updatedAt;
    })
  );
}

function resolveActiveTabId<Tab extends { id: string }>(
  tabs: Tab[],
  preferredActiveTabId: string | null,
): string | null {
  if (preferredActiveTabId && tabs.some((tab) => tab.id === preferredActiveTabId)) {
    return preferredActiveTabId;
  }

  return tabs[0]?.id ?? null;
}

function isSameTab(left: PanelTab, right: PanelTab) {
  if (left.id !== right.id || left.type !== right.type) {
    return false;
  }

  if (left.type === "artifact" && right.type === "artifact") {
    return (
      left.label === right.label &&
      left.preview === right.preview
    );
  }

  if (left.type === "browser" && right.type === "browser") {
    return isSameBrowserPanelTab(left, right);
  }

  return false;
}

function isSameSessionPanelState(
  session: SessionPanelState,
  tabs: PanelTab[],
  activeTabId: string | null,
) {
  return (
    session.tabs.length === tabs.length &&
    session.activeTabId === activeTabId &&
    session.tabs.every((tab, index) => isSameTab(tab, tabs[index]))
  );
}

function mergePersistedSessions(
  persistedState: unknown,
  currentState: PanelTabStore,
): PanelTabStore {
  const persisted = persistedState as PersistedPanelTabStore | undefined;

  if (!persisted?.sessions) {
    return currentState;
  }

  const sessions: Record<string, SessionPanelState> = {};

  for (const [sessionId, session] of Object.entries(persisted.sessions)) {
    const tabs = session.tabs
      .filter(({ type }) => type === "browser")
      .map((tab): PanelTab => ({
        ...createBrowserPanelTab(tab.id),
        viewport: normalizeBrowserViewport(tab.viewport),
        zoom: normalizeBrowserZoom(tab.zoom),
        interactionMode: normalizeBrowserInteractionMode(tab.interactionMode),
        annotations: normalizeBrowserAnnotations(tab.annotations),
        scroll: normalizeBrowserScroll(tab.scroll),
      }));

    sessions[sessionId] = {
      tabs,
      activeTabId: resolveActiveTabId(tabs, session.activeTabId),
    };
  }

  return {
    ...currentState,
    sessions,
  };
}

/**
 * The durable record for one browser tab. The return type is identity plus the
 * user-owned slice, and the fields are listed explicitly, so a newly added
 * navigation or health field can never reach storage by accident.
 */
function toPersistedBrowserTabState(tab: BrowserPanelTab): PersistedBrowserTabState {
  return {
    id: tab.id,
    type: "browser",
    viewport: tab.viewport,
    zoom: tab.zoom,
    interactionMode: tab.interactionMode,
    annotations: tab.annotations,
    scroll: tab.scroll,
  };
}

function isLegacyBrowserTabRef(value: unknown): value is { id: string; type: "browser" } {
  return isRecord(value) && typeof value.id === "string" && value.type === "browser";
}

/**
 * v1 persisted browser tabs as bare `{ id, type }` refs. Carry the open tabs
 * forward into v2 rather than dropping them on upgrade.
 */
export function migrateLegacyPanelTabSessions(legacyValue: unknown): PersistedPanelTabStore {
  const sessions: Record<string, PersistedSessionPanelState> = {};
  const persisted = isRecord(legacyValue) && isRecord(legacyValue.state)
    ? legacyValue.state
    : legacyValue;

  if (!isRecord(persisted) || !isRecord(persisted.sessions)) {
    return { sessions };
  }

  for (const [sessionId, session] of Object.entries(persisted.sessions)) {
    if (!isRecord(session) || !Array.isArray(session.tabs)) {
      continue;
    }

    const tabs = session.tabs
      .filter(isLegacyBrowserTabRef)
      .map((tab) => toPersistedBrowserTabState(createBrowserPanelTab(tab.id)));

    sessions[sessionId] = {
      tabs,
      activeTabId: resolveActiveTabId(tabs, typeof session.activeTabId === "string" ? session.activeTabId : null),
    };
  }

  return { sessions };
}

function bootstrapLegacyPanelTabStorage() {
  if (typeof localStorage === "undefined" || localStorage.getItem(PERSISTED_PANEL_TAB_STORE_KEY)) {
    return;
  }

  const legacy = localStorage.getItem(LEGACY_PANEL_TAB_STORE_KEY);

  if (!legacy) {
    return;
  }

  try {
    const migrated = migrateLegacyPanelTabSessions(JSON.parse(legacy));
    // zustand's createJSONStorage envelope, which is what the store rehydrates.
    localStorage.setItem(PERSISTED_PANEL_TAB_STORE_KEY, JSON.stringify({ state: migrated, version: 0 }));
  } catch {
    // A corrupt legacy blob must not block boot; the v1 key is dropped either way.
  }

  localStorage.removeItem(LEGACY_PANEL_TAB_STORE_KEY);
}

bootstrapLegacyPanelTabStorage();

export const usePanelTabStore = create<PanelTabStore>()(
  persist(
    (set, get) => ({
      sessions: {},
      transcriptArtifactTargets: {},
      openTab: (sessionId, tab) => set((state) => {
        const session = getWritableSession(state, sessionId);
        const existingIndex = session.tabs.findIndex((entry) => entry.id === tab.id);

        if (existingIndex >= 0) {
          const tabs = [...session.tabs];
          tabs[existingIndex] = tab;

          return updateSession(state, sessionId, {
            tabs,
            activeTabId: tab.id,
          });
        }

        return updateSession(state, sessionId, {
          tabs: [...session.tabs, tab],
          activeTabId: tab.id,
        });
      }),
      closeTab: (sessionId, tabId) => set((state) => {
        const session = getWritableSession(state, sessionId);
        const index = session.tabs.findIndex((tab) => tab.id === tabId);
        if (index < 0) {
          return state;
        }

        const tabs = session.tabs.filter((tab) => tab.id !== tabId);
        const activeTabId = session.activeTabId === tabId
          ? resolveActiveTabId(tabs, tabs[index]?.id ?? tabs[index - 1]?.id ?? null)
          : session.activeTabId;

        return updateSession(state, sessionId, { tabs, activeTabId });
      }),
      selectTab: (sessionId, tabId) => set((state) => {
        const session = getWritableSession(state, sessionId);
        if (!session.tabs.some((tab) => tab.id === tabId)) {
          return state;
        }

        if (session.activeTabId === tabId) {
          return state;
        }

        return updateSession(state, sessionId, {
          ...session,
          activeTabId: tabId,
        });
      }),
      reorderTabs: (sessionId, tabIds) => set((state) => {
        const session = getWritableSession(state, sessionId);
        const tabsById = new Map(session.tabs.map((tab) => [tab.id, tab]));
        const reorderedTabs = tabIds
          .map((tabId) => tabsById.get(tabId))
          .filter((tab): tab is PanelTab => Boolean(tab));

        if (reorderedTabs.length !== session.tabs.length) {
          return state;
        }

        return updateSession(state, sessionId, {
          ...session,
          tabs: reorderedTabs,
        });
      }),
      syncBrowserTabs: (sessionId, browserTabs, activeBrowserTabId) => set((state) => {
        const session = getWritableSession(state, sessionId);
        const browserTabsById = new Map(browserTabs.map((tab) => [tab.id, tab]));

        const mergedTabs: PanelTab[] = [];

        for (const tab of session.tabs) {
          // Only browser tabs are reconciled with Electron; everything else is
          // carried through untouched.
          if (tab.type !== "browser") {
            mergedTabs.push(tab);
            continue;
          }

          const navigation = browserTabsById.get(tab.id);
          if (!navigation) {
            // Electron closed this tab; keep the rest untouched.
            continue;
          }

          // Electron owns navigation and health. Viewport, zoom, annotations,
          // and interaction mode are the user's and survive every sync.
          mergedTabs.push(mergeBrowserTabNavigation(tab, navigation));
          browserTabsById.delete(tab.id);
        }

        for (const navigation of browserTabsById.values()) {
          mergedTabs.push(mergeBrowserTabNavigation(createBrowserPanelTab(navigation.id), navigation));
        }

        const currentActiveTab = session.tabs.find((tab) => tab.id === session.activeTabId);
        const shouldSyncActiveFromElectron =
          !session.activeTabId || currentActiveTab?.type === "browser";

        const activeTabId = shouldSyncActiveFromElectron
          ? resolveActiveTabId(mergedTabs, activeBrowserTabId)
          : resolveActiveTabId(mergedTabs, session.activeTabId);

        if (isSameSessionPanelState(session, mergedTabs, activeTabId)) {
          return state;
        }

        return updateSession(state, sessionId, {
          tabs: mergedTabs,
          activeTabId,
        });
      }),
      setBrowserViewport: (sessionId, tabId, viewport) => set((state) => (
        updateBrowserTab(state, sessionId, tabId, (tab) => ({ ...tab, viewport }))
      )),
      setBrowserZoom: (sessionId, tabId, zoom) => set((state) => (
        updateBrowserTab(state, sessionId, tabId, (tab) => ({ ...tab, zoom }))
      )),
      setBrowserInteractionMode: (sessionId, tabId, mode) => set((state) => (
        updateBrowserTab(state, sessionId, tabId, (tab) => ({ ...tab, interactionMode: mode }))
      )),
      addBrowserAnnotation: (sessionId, tabId, annotation) => set((state) => (
        updateBrowserTab(state, sessionId, tabId, (tab) => ({ ...tab, annotations: [...tab.annotations, annotation] }))
      )),
      syncArtifactTargets: (sessionId, targets) => set((state) => {
        const session = getWritableSession(state, sessionId);
        const nextSession = reconcileOpenArtifactTabs(session, targets);

        if (isSameSessionPanelState(session, nextSession.tabs, nextSession.activeTabId)) {
          return state;
        }

        return updateSession(state, sessionId, nextSession);
      }),
      syncTranscriptArtifacts: (sessionId, targets) => set((state) => {
        const currentTranscript = state.transcriptArtifactTargets[sessionId] ?? [];
        const session = getWritableSession(state, sessionId);
        const collectibleTargets = targets
          .filter(isCollectibleArtifactTarget)
          .map((target) => ({
            id: target.id,
            name: target.name,
            preview: target.preview,
          }));
        const nextSession = reconcileOpenArtifactTabs(session, collectibleTargets);
        const transcriptChanged = !isSameTranscriptArtifactTargets(currentTranscript, targets);
        const sessionChanged = !isSameSessionPanelState(session, nextSession.tabs, nextSession.activeTabId);

        if (!transcriptChanged && !sessionChanged) {
          return state;
        }

        const sessionUpdate = sessionChanged ? updateSession(state, sessionId, nextSession) : null;

        return {
          transcriptArtifactTargets: transcriptChanged ? {
            ...state.transcriptArtifactTargets,
            [sessionId]: targets,
          } : state.transcriptArtifactTargets,
          sessions: sessionUpdate?.sessions ?? state.sessions,
        };
      }),
      clearSession: (sessionId) => set((state) => {
        const nextSessions = { ...state.sessions };
        const nextTranscriptArtifactTargets = { ...state.transcriptArtifactTargets };
        
        let changed = false;

        if (state.sessions[sessionId]) {
          delete nextSessions[sessionId];
          changed = true;
        }

        if (state.transcriptArtifactTargets[sessionId]) {
          delete nextTranscriptArtifactTargets[sessionId];
          changed = true;
        }

        if (!changed) {
          return state;
        }

        return {
          sessions: nextSessions,
          transcriptArtifactTargets: nextTranscriptArtifactTargets,
        };
      }),
    }),
    {
      name: PERSISTED_PANEL_TAB_STORE_KEY,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        sessions: Object.fromEntries(
          Object.entries(state.sessions).map(([sessionId, session]) => {
            const tabs = session.tabs
              .filter((tab) => tab.type === "browser")
              .map(toPersistedBrowserTabState);

            return [
              sessionId,
              {
                tabs,
                activeTabId: resolveActiveTabId(tabs, session.activeTabId),
              },
            ];
          }),
        ),
      }),
      merge: (persistedState, currentState) => mergePersistedSessions(persistedState, currentState),
    },
  ),
);

export function useSessionPanelState(sessionId: string): SessionPanelState {
  return usePanelTabStore((state) => state.sessions[sessionId] ?? EMPTY_SESSION);
}

export function useActivePanelTab(sessionId: string): PanelTab | null {
  return usePanelTabStore((state) => {
    const session = state.sessions[sessionId] ?? EMPTY_SESSION;

    return session.tabs.find((tab) => tab.id === session.activeTabId) ?? session.tabs[0] ?? null;
  });
}
