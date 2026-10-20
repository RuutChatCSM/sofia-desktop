import { expect, vi } from "vitest";
import { test } from "@sofia/testkit";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; }, clear: () => values.clear(),
    getItem: key => values.get(key) ?? null, key: index => [...values.keys()][index] ?? null,
    removeItem: key => { values.delete(key); }, setItem: (key, value) => { values.set(key, value); },
  };
}

test("fresh presentation stores restore each session's layout rather than defaulting to Peek", async () => {
  vi.stubGlobal("localStorage", memoryStorage());
  try {
    vi.resetModules();
    const { useBrowserPresentationStore: first } = await import("../../apps/app/src/react-app/domains/session/panel/browser-presentation");
    for (const [scope, event] of [
      ["session:split", "user-dock-browser"], ["session:expanded", "user-expand-browser"],
      ["session:peek", "user-show-peek"], ["session:hidden", "user-hide-peek"],
    ] as const) {
      first.getState().activateScope(scope, "hidden");
      first.getState().dispatch({ type: event });
    }
    first.getState().activateScope("session:peek", "hidden");
    first.getState().dispatch({ type: "user-move-peek", position: { x: 80, y: 120 } });
    first.getState().dispatch({ type: "attention-required", reason: "captcha", url: "https://example.test" });
    vi.resetModules();
    const { useBrowserPresentationStore: reopened } = await import("../../apps/app/src/react-app/domains/session/panel/browser-presentation");
    for (const [scope, mode] of [["split", "docked"], ["expanded", "expanded"], ["peek", "peek"], ["hidden", "hidden"]]) {
      reopened.getState().activateScope(`session:${scope}`, "hidden");
      expect(reopened.getState().state.runtime.mode).toBe(mode);
      expect(reopened.getState().state.runtime.attention).toBeNull();
      reopened.getState().dispatch({ type: "agent-browser-started" });
      expect(reopened.getState().state.runtime.mode).toBe(mode);
    }
    reopened.getState().activateScope("session:peek", "hidden");
    expect(reopened.getState().state.runtime.peekPosition).toEqual({ x: 80, y: 120 });
    reopened.getState().activateScope("session:brand-new", "hidden");
    expect(reopened.getState().state.runtime.mode).toBe("hidden");
    expect(reopened.getState().state.runtime.peekPosition).toBeNull();
  } finally { vi.unstubAllGlobals(); }
});

test("older panel layout migrates once and invalid stored presentation is ignored", async () => {
  const storage = memoryStorage();
  storage.setItem("sofia:browser-presentation:v1", JSON.stringify({ state: {
    state: { preferences: { autoShow: "never", dockedWidth: 684 } },
    sessions: { invalid: { mode: "bad" }, expanded: { mode: "expanded", peekPosition: { x: "bad", y: 0 } } },
  }, version: 0 }));
  vi.stubGlobal("localStorage", storage);
  try {
    vi.resetModules();
    const { useBrowserPresentationStore: store } = await import("../../apps/app/src/react-app/domains/session/panel/browser-presentation");
    expect(store.getState().sessions.invalid).toBeUndefined();
    store.getState().activateScope("legacy", "expanded");
    expect(store.getState().state.runtime.mode).toBe("expanded");
    expect(store.getState().state.runtime.restore).toEqual({ mode: "docked", width: 684 });
    store.getState().dispatch({ type: "user-hide-peek" });
    store.getState().activateScope("another", "hidden");
    store.getState().activateScope("legacy", "docked");
    expect(store.getState().state.runtime.mode).toBe("hidden");
    store.getState().dispatch({ type: "agent-browser-started" });
    expect(store.getState().state.runtime.mode).toBe("hidden");
  } finally { vi.unstubAllGlobals(); }
});
