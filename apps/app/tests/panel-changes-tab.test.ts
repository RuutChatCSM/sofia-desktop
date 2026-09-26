import { describe, expect, test } from "bun:test";

import { usePanelTabStore } from "../src/react-app/domains/session/panel/panel-tab-store";

describe("the review workspace is a docked panel tab", () => {
  test("a changes tab carries the immutable change set it reviews", () => {
    const store = usePanelTabStore.getState();
    store.clearSession("s1");

    usePanelTabStore.getState().openTab("s1", {
      id: "changes:turn:s1:t31",
      type: "changes",
      label: "Changes",
      changeSetId: "turn:s1:t31",
    });

    const session = usePanelTabStore.getState().sessions["s1"];
    expect(session?.tabs).toHaveLength(1);
    expect(session?.tabs[0]).toMatchObject({ type: "changes", changeSetId: "turn:s1:t31" });
    expect(session?.activeTabId).toBe("changes:turn:s1:t31");

    usePanelTabStore.getState().clearSession("s1");
  });

  test("syncing browser tabs leaves the review tab untouched", () => {
    // The Electron reconciler must not drop or rewrite a non-browser tab.
    usePanelTabStore.getState().openTab("s2", {
      id: "changes:turn:s2:t1",
      type: "changes",
      label: "Changes",
      changeSetId: "turn:s2:t1",
    });

    usePanelTabStore.getState().syncBrowserTabs("s2", [], null);

    const tabs = usePanelTabStore.getState().sessions["s2"]?.tabs ?? [];
    expect(tabs.map((tab) => tab.type)).toEqual(["changes"]);
    expect(tabs[0]).toMatchObject({ changeSetId: "turn:s2:t1" });

    usePanelTabStore.getState().clearSession("s2");
  });
});
