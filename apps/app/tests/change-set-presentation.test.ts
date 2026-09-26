import { describe, expect, test } from "bun:test";

import {
  beginTurnChangeSet,
  changeSetByRepository,
  finalizeTurnChangeSet,
  reconcileTurnChangeSet,
  sortFilesByChurn,
  type FileChange,
} from "../src/react-app/domains/session/changes/turn-change-set";

function file(path: string, additions: number, deletions: number, status: FileChange["status"] = "modified"): FileChange {
  return { path, status, additions, deletions, attributedToTurn: true };
}

describe("significance order", () => {
  test("the file the turn worked on comes before an alphabetical accident", () => {
    const sorted = sortFilesByChurn([
      file("aaa-tiny.ts", 1, 0),
      file("zzz-big.ts", 80, 20),
      file("mmm-mid.ts", 10, 5),
    ]);

    expect(sorted.map((entry) => entry.path)).toEqual(["zzz-big.ts", "mmm-mid.ts", "aaa-tiny.ts"]);
  });

  test("binaries have no line counts, so they sink below real edits", () => {
    const sorted = sortFilesByChurn([file("hero.png", 0, 0, "binary"), file("a.ts", 1, 0)]);
    expect(sorted.map((entry) => entry.path)).toEqual(["a.ts", "hero.png"]);
  });

  test("equal churn falls back to a stable path order", () => {
    const sorted = sortFilesByChurn([file("b.ts", 2, 2), file("a.ts", 2, 2)]);
    expect(sorted.map((entry) => entry.path)).toEqual(["a.ts", "b.ts"]);
  });
});

describe("repositories stay separate", () => {
  test("the same path in two repositories is two files, not one", () => {
    const started = beginTurnChangeSet({ sessionId: "s1", turnId: "t31", startedAt: 0 });
    const changeSet = finalizeTurnChangeSet(
      reconcileTurnChangeSet(started, {
        source: "git",
        repositories: [
          { repositoryId: "sofia-app", root: "/a", files: [file("src/index.ts", 4, 1)] },
          { repositoryId: "sofia", root: "/b", files: [file("src/index.ts", 2, 0)] },
        ],
      }),
      1_000,
    );

    const groups = changeSetByRepository(changeSet);

    expect(groups.map((group) => group.repositoryId)).toEqual(["sofia-app", "sofia"]);
    expect(groups.map((group) => group.files.length)).toEqual([1, 1]);
    expect(groups[0]?.files[0]?.additions).toBe(4);
    expect(groups[1]?.files[0]?.additions).toBe(2);
  });
});
