import * as React from "react";

import type { BrowserStatePayload } from "@/app/lib/desktop";
import type { BrowserViewport, BrowserZoom } from "@/app/lib/desktop-types";

import {
  type PanelTab,
  usePanelTabStore,
} from "./panel-tab-store";
import { getElectronBrowser } from "./utils";
import { NO_SESSION_SIDE_PANEL_KEY } from "./side-panel-session";

/** Native state is authoritative only after the requested session owns the scope. */
export function subscribeSessionBrowserTabs(
  browser: NonNullable<ReturnType<typeof getElectronBrowser>>,
  scopeId: string,
  applyBrowserState: (state: BrowserStatePayload) => void,
  applyControls: (controls: { tabId: string; viewport: BrowserViewport; zoom: BrowserZoom }) => void,
) {
  let disposed = false;
  let ready = false;
  const apply = (state: BrowserStatePayload) => {
    if (!disposed && ready && state.scopeId === scopeId) applyBrowserState(state);
  };
  const unsubscribe = browser.onStateChange?.(apply);
  const unsubscribeControls = browser.onControlsChange?.((controls) => {
    if (!disposed && ready) applyControls(controls);
  });
  void (async () => {
    if (!browser.setScope || await browser.setScope(scopeId) !== scopeId || disposed) return;
    ready = true;
    const state = await browser.getState?.();
    if (state) apply(state);
  })().catch(() => {
    // A disconnected native bridge must not clear the durable renderer state.
  });
  return () => {
    disposed = true;
    unsubscribe?.();
    unsubscribeControls?.();
  };
}

export function useBrowserTabSync(sessionId: string, workspaceId: string) {
  const syncBrowserTabs = usePanelTabStore((state) => state.syncBrowserTabs);
  React.useEffect(() => {
    const browser = getElectronBrowser();
    if (!browser) return;
    const scopeId = sessionId === NO_SESSION_SIDE_PANEL_KEY
      ? `workspace:${workspaceId}` : `session:${sessionId.trim()}`;
    return subscribeSessionBrowserTabs(browser, scopeId, (state) => {
      const tabs = state.tabs ?? [];
      syncBrowserTabs(sessionId, tabs, state.activeTabId ?? tabs[0]?.id ?? null);
    }, ({ tabId, viewport, zoom }) => {
      const store = usePanelTabStore.getState();
      store.setBrowserViewport(sessionId, tabId, viewport);
      store.setBrowserZoom(sessionId, tabId, zoom);
    });
  }, [sessionId, workspaceId, syncBrowserTabs]);
}

export function useSidePanelTabs(sessionId: string) {
  const createTab = useCreateTab();

  const closeTab = useCloseTab();

  const selectTab = useSelectTab();

  const reorderTabs = useReorderTabs();

  return {
    createTab: (url?: string) => createTab(url),
    closeTab: (tab: PanelTab) => closeTab(sessionId, tab),
    selectTab: (tabId: string) => selectTab(sessionId, tabId),
    reorderTabs: (tabIds: string[]) => reorderTabs(sessionId, tabIds),
  };
}

export function useCreateTab() {
  return React.useCallback((url?: string) => {
    void getElectronBrowser()?.createTab?.(url);
  }, []);
}

export function useCloseTab() {
  const closeTab = usePanelTabStore((state) => state.closeTab);

  return React.useCallback((sessionId: string, tab: PanelTab) => {
    if (tab.type === "browser") {
      void getElectronBrowser()?.closeTab?.(tab.id);

      return;
    }

    const wasActive = usePanelTabStore.getState().sessions[sessionId]?.activeTabId === tab.id;

    closeTab(sessionId, tab.id);

    if (wasActive) {
      const nextTabId = usePanelTabStore.getState().sessions[sessionId]?.activeTabId;
      const nextTab = usePanelTabStore.getState().sessions[sessionId]?.tabs.find((entry) => entry.id === nextTabId);

      if (nextTab?.type === "browser") {
        void getElectronBrowser()?.selectTab?.(nextTab.id);
      }
    }
  }, [closeTab]);
}

export function useSelectTab() {
  const selectTab = usePanelTabStore((state) => state.selectTab);

  return React.useCallback((sessionId: string, tabId: string) => {
    const tabs = usePanelTabStore.getState().sessions[sessionId]?.tabs ?? [];
    const tab = tabs.find((entry) => entry.id === tabId);

    if (!tab) {
      return;
    }

    selectTab(sessionId, tabId);

    if (tab.type === "browser") {
      void getElectronBrowser()?.selectTab?.(tabId);
    }
  }, [selectTab]);
}

export function useReorderTabs() {
  const reorderTabs = usePanelTabStore((state) => state.reorderTabs);

  return React.useCallback((sessionId: string, tabIds: string[]) => {
    const tabs = usePanelTabStore.getState().sessions[sessionId]?.tabs ?? [];
    const browserTabsById = new Map(
      tabs
        .filter((tab) => tab.type === "browser")
        .map((tab) => [tab.id, tab]),
    );
    const browserTabIds = tabIds.filter((tabId) => browserTabsById.has(tabId));

    reorderTabs(sessionId, tabIds);

    void getElectronBrowser()?.reorderTabs?.(browserTabIds);
  }, [reorderTabs]);
}

// Panel bounds, page viewport, and zoom are three separate user intents. These
// hooks deliberately go through three separate IPC calls; nothing combines them.
export function useSetBrowserViewport() {
  const setBrowserViewport = usePanelTabStore((state) => state.setBrowserViewport);

  return React.useCallback((sessionId: string, tabId: string, viewport: BrowserViewport) => {
    setBrowserViewport(sessionId, tabId, viewport);
    void getElectronBrowser()?.setViewport?.(tabId, viewport);
  }, [setBrowserViewport]);
}

export function useSetBrowserZoom() {
  const setBrowserZoom = usePanelTabStore((state) => state.setBrowserZoom);

  return React.useCallback((sessionId: string, tabId: string, zoom: BrowserZoom) => {
    setBrowserZoom(sessionId, tabId, zoom);
    void getElectronBrowser()?.setZoom?.(tabId, zoom);
  }, [setBrowserZoom]);
}
