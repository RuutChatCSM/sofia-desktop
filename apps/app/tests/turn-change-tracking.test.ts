import { describe, expect, test } from "bun:test";

import { useChangeSetStore } from "../src/react-app/domains/session/changes/change-set-store";
import {
  captureTurnBaseline,
  finalizeTurnChangeSet,
  resetTurnBaselines,
  type WorkspaceChangesClient,
} from "../src/react-app/domains/session/changes/turn-change-tracking";

/**
 * A fake workspace client: this is the whole point of the refactor — the turn's
 * patch no longer needs the codex app-server, so an engine-driven session can
 * produce one.
 */
function fakeClient(): WorkspaceChangesClient & { calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  let snapshots = 0;
  return {
    calls,
    git: {
      changes: async (params) => {
        calls.push(params as Record<string, unknown>);
        if (params.snapshot) {
          // First snapshot is the turn's baseline, the second the tree it ended at.
          snapshots += 1;
          return { revision: null, files: [], tree: snapshots === 1 ? "base-tree" : "end-tree", head: "abc" };
        }
        if (params.baselineTree) {
          return {
            revision: "end-tree",
            files: [{ path: "sofia.ts", status: "added", additions: 2, deletions: 0 }],
            patch: "diff --git a/sofia.ts b/sofia.ts",
            commits: ["def"],
          };
        }
        return { revision: "abc", files: [{ path: "tracked.ts", status: "modified", additions: 9, deletions: 3 }] };
      },
    },
  };
}

describe("turn change tracking is not codex-specific", () => {
  test("capture a baseline, then freeze the turn's patch from the tree diff", async () => {
    resetTurnBaselines();
    useChangeSetStore.getState().clear();
    const client = fakeClient();

    await captureTurnBaseline({ client, workspaceId: "ws", sessionId: "engine-1", turnId: "t1" });
    await finalizeTurnChangeSet({ client, workspaceId: "ws", sessionId: "engine-1", turnId: "t1" });

    const stored = useChangeSetStore.getState().byId["turn:engine-1:t1"];
    expect(stored?.source).toBe("git");
    expect(stored?.repositories[0]?.files[0]).toMatchObject({ path: "sofia.ts", additions: 2 });
    // The patch and the commits ride with the frozen set.
    expect(stored?.repositories[0]?.patch).toContain("diff --git");
    expect(stored?.repositories[0]?.commitsInRange).toEqual(["def"]);
    // And the session remembers its newest set, for a transcript that has no id.
    expect(useChangeSetStore.getState().latestBySession["engine-1"]).toBe("turn:engine-1:t1");

    // The delta was read between the two trees, not from the working tree.
    const deltaCall = client.calls.find((call) => call.baselineTree);
    expect(deltaCall).toMatchObject({ baselineTree: "base-tree", endTree: "end-tree", hunks: true, patch: true });
    useChangeSetStore.getState().clear();
  });

  test("no client means no change set, and nothing throws", async () => {
    resetTurnBaselines();
    useChangeSetStore.getState().clear();
    await captureTurnBaseline({ client: null, workspaceId: "ws", sessionId: "s", turnId: "t" });
    await finalizeTurnChangeSet({ client: null, workspaceId: "ws", sessionId: "s", turnId: "t" });
    expect(useChangeSetStore.getState().byId).toEqual({});
  });
});
