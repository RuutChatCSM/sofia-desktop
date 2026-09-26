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

  test("finalize waits for a baseline read that is still in flight", async () => {
    // Capture is fire-and-forget at turn start, so a short turn can reach
    // finalize first. Without the wait the turn would be frozen as unattributed
    // even though its baseline was only milliseconds away.
    resetTurnBaselines();
    useChangeSetStore.getState().clear();

    let releaseSnapshot = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    const client: WorkspaceChangesClient = {
      git: {
        changes: async (params) => {
          if (params.snapshot) {
            await gate;
            return {
              revision: null,
              files: [],
              repositories: [{ repositoryId: "ws", root: "/repo", tree: "base-tree", head: "abc" }],
            };
          }
          const files = [{ path: "a.ts", status: "modified" as const, additions: 1, deletions: 1 }];
          return {
            revision: "end",
            files,
            patch: "diff --git a/a.ts b/a.ts",
            repositories: [
              {
                repositoryId: "ws",
                root: "/repo",
                revision: "end",
                baselineTree: "base-tree",
                endTree: "end",
                patch: "diff --git a/a.ts b/a.ts",
                files,
              },
            ],
          };
        },
      },
    };

    const capturing = captureTurnBaseline({ client, workspaceId: "ws", sessionId: "race", turnId: "t1" });
    const finalizing = finalizeTurnChangeSet({ client, workspaceId: "ws", sessionId: "race", turnId: "t1" });
    releaseSnapshot();
    await Promise.all([capturing, finalizing]);

    const stored = useChangeSetStore.getState().byId["turn:race:t1"];
    expect(stored?.attributed).not.toBe(false);
    expect(stored?.repositories[0]?.baselineTree).toBe("base-tree");
    expect(stored?.repositories[0]?.patch).toBe("diff --git a/a.ts b/a.ts");
    useChangeSetStore.getState().clear();
  });

  test("without a baseline the set is marked unattributed, not claimed as the turn's", async () => {
    // No capture ran for this turn, so the read is the repository's current
    // state. Yesterday's dirtiness must never be presented as this turn's work.
    resetTurnBaselines();
    useChangeSetStore.getState().clear();
    const dirty = { path: "someone-elses.ts", status: "modified" as const, additions: 40, deletions: 2 };
    const client: WorkspaceChangesClient = {
      git: {
        changes: async () => ({
          revision: "r1",
          files: [dirty],
          repositories: [{ repositoryId: "ws", root: "/repo", revision: "r1", files: [dirty] }],
        }),
      },
    };

    await finalizeTurnChangeSet({ client, workspaceId: "ws", sessionId: "unbased", turnId: "t1" });

    const stored = useChangeSetStore.getState().byId["turn:unbased:t1"];
    expect(stored?.source).toBe("git");
    expect(stored?.attributed).toBe(false);
    expect(stored?.repositories[0]?.files[0]?.attributedToTurn).toBe(false);
    useChangeSetStore.getState().clear();
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
