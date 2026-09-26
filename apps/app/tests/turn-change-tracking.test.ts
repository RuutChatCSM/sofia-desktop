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
  return {
    calls,
    git: {
      changes: async (params) => {
        calls.push(params as Record<string, unknown>);
        // A snapshot read returns one baseline per repository.
        if (params.snapshot) {
          return {
            revision: null,
            files: [],
            repositories: [{ repositoryId: "ws", root: "/repo", tree: "base-tree", head: "abc" }],
          };
        }
        // The turn's delta is the per-repository diff of those baselines.
        if (params.baselines?.length) {
          const files = [{ path: "sofia.ts", status: "added" as const, additions: 2, deletions: 0 }];
          return {
            revision: null,
            files,
            patch: "diff --git a/sofia.ts b/sofia.ts",
            commits: ["def"],
            repositories: [{ repositoryId: "ws", root: "/repo", revision: "end-tree", files }],
          };
        }
        return { revision: null, files: [] };
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

    // The delta was read between the recorded baselines, not from the working tree.
    const deltaCall = client.calls.find((call) => Array.isArray(call.baselines));
    expect(deltaCall).toMatchObject({ hunks: true });
    expect(deltaCall?.baselines).toEqual([{ repositoryId: "ws", root: "/repo", tree: "base-tree", head: "abc" }]);
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

describe("a session-scoped client is enough", () => {
  test("falls back to the codex client when no workspace client is bound", async () => {
    // The engine client is not bound for every session; without this fallback
    // those sessions logged nothing at all and silently stayed hint-only.
    resetTurnBaselines();
    useChangeSetStore.getState().clear();

    const sessionScoped: WorkspaceChangesClient = {
      workspaceChanges: async (_sessionId, params) => {
        if (params?.snapshot) {
          return {
            revision: null,
            files: [],
            repositories: [{ repositoryId: "codex-ws", root: "/repo", tree: "base", head: "abc" }],
          };
        }
        if (params?.baselines?.length) {
          const files = [{ path: "a.ts", status: "modified" as const, additions: 1, deletions: 1 }];
          return { revision: "end", files, repositories: [{ repositoryId: "codex-ws", root: "/repo", files }] };
        }
        return { revision: "abc", files: [] };
      },
    };

    await captureTurnBaseline({ client: sessionScoped, workspaceId: "ws", sessionId: "codex-1", turnId: "t9" });
    await finalizeTurnChangeSet({ client: sessionScoped, workspaceId: "ws", sessionId: "codex-1", turnId: "t9" });

    expect(useChangeSetStore.getState().byId["turn:codex-1:t9"]?.source).toBe("git");
    useChangeSetStore.getState().clear();
  });
});
