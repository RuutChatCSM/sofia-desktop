import { expect, vi } from "vitest";
import { test } from "@sofia/testkit";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
  };
}

test("session workspace tabs survive rehydration with bounded descriptors and selection", async () => {
  const storage = memoryStorage();
  vi.stubGlobal("localStorage", storage);
  try {
    const { usePanelTabStore: store, PERSISTED_PANEL_TAB_STORE_KEY: key, migrateLegacyPanelTabSessions, resolveArtifactPanelTarget } = await import("../../apps/app/src/react-app/domains/session/panel/panel-tab-store");
    expect(migrateLegacyPanelTabSessions({ state: { sessions: { old: {
      tabs: [{ type: "browser", id: "old-browser" }], activeTabId: "old-browser",
    } } } }).sessions.old.activeTabId).toBe("old-browser");
    store.setState({ sessions: {}, transcriptArtifactTargets: {} });
    store.getState().openTab("one", { id: "files", type: "files", label: "Files", path: "/workspace" });
    store.getState().syncTranscriptArtifacts("one", [{ id: "artifact", kind: "file", value: "Reports/CaseSensitive.PDF", name: "Report", preview: "pdf", confidence: 100, reason: "manual", exists: true }]);
    store.getState().openTab("one", { id: "artifact", type: "artifact", label: "Report", preview: "pdf" });
    store.getState().openTab("one", { id: "review", type: "changes", label: "Review", changeSetId: "immutable", filePath: "a.ts" });
    store.getState().openTab("one", { id: "image", type: "source-image", label: "Image", src: "data:image/png;base64," + "x".repeat(100_000) });
    for (const type of ["start", "sources", "subagents"] as const) {
      store.getState().openTab("two", { id: type, type, label: type });
    }
    store.getState().openTab("two", { id: "stable-image", type: "source-image", label: "Saved image", src: "https://example.com/image.png" });
    store.getState().openTab("two", { id: "outputs", type: "outputs", label: "Outputs" });
    store.getState().reorderTabs("one", ["review", "artifact", "files", "image"]);
    store.getState().selectTab("one", "artifact");
    const saved = storage.getItem(key);
    expect(saved?.length).toBeLessThan(2000);
    expect(saved).not.toContain("base64");
    store.setState({ sessions: {} });
    if (!saved) throw new Error("Missing persistence");
    storage.setItem(key, saved);
    await store.persist.rehydrate();
    expect(store.getState().sessions.one.tabs.map((tab) => tab.id)).toEqual(["review", "artifact", "files"]);
    expect(store.getState().sessions.one.activeTabId).toBe("artifact");
    const restoredArtifact = store.getState().sessions.one.tabs.find((tab) => tab.type === "artifact");
    if (restoredArtifact?.type !== "artifact") throw new Error("Missing restored artifact");
    expect(restoredArtifact.target).toEqual({ kind: "file", value: "Reports/CaseSensitive.PDF" });
    expect(resolveArtifactPanelTarget(restoredArtifact, [])).toMatchObject({ kind: "file", value: "Reports/CaseSensitive.PDF", preview: "pdf" });
    expect(store.getState().sessions.two.activeTabId).toBe("outputs");
    expect(store.getState().sessions.two.tabs.map((tab) => tab.id)).toEqual(["start", "sources", "subagents", "stable-image", "outputs"]);
    store.getState().syncTranscriptArtifacts("one", []);
    expect(store.getState().sessions.one.tabs.map((tab) => tab.id)).toEqual(["review", "artifact", "files"]);
    storage.setItem(key, JSON.stringify({ state: { sessions: { broken: { tabs: [null, { type: "artifact", id: "bad", label: "Bad", preview: {} }] } } }, version: 0 }));
    await store.persist.rehydrate();
    expect(store.getState().sessions.broken.tabs).toEqual([]);
  } finally {
    vi.unstubAllGlobals();
  }
});

test("panel visibility persists independently per session and older layout state loads", async () => {
  const storage = memoryStorage();
  storage.setItem("sofia:ui-state:v1", JSON.stringify({ workspaceLeftSidebarWidth: 300, sidePanelState: { one: "panel", two: null, three: "extensions", bad: "unknown" }, sidePanelExpandedState: { one: true, two: false, invalid: "true", invalidNumber: 1 } }));
  vi.stubGlobal("window", { localStorage: storage, document: { cookie: "" }, innerWidth: 1200 });
  try {
    const { useUiStateStore: store } = await import("../../apps/app/src/react-app/shell/ui-state-store");
    expect(store.getState().workspaceLeftSidebarWidth).toBe(300);
    expect(store.getState().sidePanelState).toEqual({ one: "panel", two: null, three: "extensions" });
    expect(store.getState().sidePanelExpandedState).toEqual({ one: true, two: false });
    store.getState().setSidePanelExpanded("two", true);
    store.getState().setSidePanelExpanded("one", false);
    store.getState().setSidePanelState("two", "voice");
    const saved = JSON.parse(storage.getItem("sofia:ui-state:v1") ?? "null");
    expect(saved.sidePanelState).toEqual({ one: "panel", two: "voice", three: "extensions" });
    expect(saved.sidePanelExpandedState).toEqual({ one: false, two: true });
    expect(saved).not.toHaveProperty("workspaceLeftSidebarResizing");
  } finally {
    vi.unstubAllGlobals();
  }
});
