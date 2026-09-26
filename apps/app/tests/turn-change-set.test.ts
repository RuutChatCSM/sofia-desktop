import { describe, expect, test } from "bun:test";

import { changeSetFromToolHints } from "../src/react-app/domains/session/changes/change-set-from-messages";
import {
  attributedFiles,
  beginTurnChangeSet,
  canUndoChangeSet,
  changeSetFiles,
  changeSetTitle,
  changeSetTotals,
  fileChangeLabel,
  fileChangeNote,
  finalizeTurnChangeSet,
  isFrozen,
  parseNumStat,
  reconcileTurnChangeSet,
  turnChangeSetId,
  unattributedFiles,
  type TurnChangeSet,
} from "../src/react-app/domains/session/changes/turn-change-set";

function gitSet(files = parseNumStat("51\t18\tscroll-controller.ts\n72\t0\tclipboard-payload.ts")) {
  const started = beginTurnChangeSet({ sessionId: "s1", turnId: "t31", startedAt: 1_000 });
  return reconcileTurnChangeSet(started, {
    source: "git",
    repositories: [{ repositoryId: "repo-1", root: "/repo", baseRevision: "abc123", files }],
  });
}

describe("a change set is a durable object, not a tool log", () => {
  test("identity is immutable and belongs to the turn", () => {
    const started = beginTurnChangeSet({ sessionId: "s1", turnId: "t31", startedAt: 1_000 });
    expect(started.id).toBe(turnChangeSetId("s1", "t31"));

    const reconciled = reconcileTurnChangeSet(started, {
      source: "git",
      repositories: [{ repositoryId: "repo-1", root: "/repo", files: parseNumStat("1\t0\ta.ts") }],
    });
    const frozen = finalizeTurnChangeSet(reconciled, 5_000);

    // A card addresses the set by id; the id never moves.
    expect(reconciled.id).toBe(started.id);
    expect(frozen.id).toBe(started.id);
    expect(frozen.startedAt).toBe(1_000);
    expect(frozen.finalizedAt).toBe(5_000);
    expect(isFrozen(frozen)).toBe(true);
  });

  test("a finalized turn can never be rewritten by a later observation", () => {
    // This is the invariant behind "a historical card must not show whatever is
    // in the working tree right now".
    const frozen = finalizeTurnChangeSet(gitSet(), 5_000);

    const later = reconcileTurnChangeSet(frozen, {
      source: "git",
      repositories: [{ repositoryId: "repo-1", root: "/repo", files: parseNumStat("999\t999\tsomething-else.ts") }],
    });

    expect(later).toEqual(frozen);
    expect(changeSetFiles(later).map((file) => file.path)).toEqual(["scroll-controller.ts", "clipboard-payload.ts"]);
  });

  test("finalizing twice keeps the first completion", () => {
    const once = finalizeTurnChangeSet(gitSet(), 5_000);
    expect(finalizeTurnChangeSet(once, 9_000).finalizedAt).toBe(5_000);
  });

  test("a hint stream never overwrites a repository-backed set", () => {
    const fromGit = gitSet();
    const downgraded = reconcileTurnChangeSet(fromGit, {
      source: "tool-events",
      repositories: [{ repositoryId: "workspace", root: "", files: [{ path: "a.ts", status: "modified", additions: 0, deletions: 0, attributedToTurn: true }] }],
    });

    expect(downgraded).toEqual(fromGit);
    expect(downgraded.source).toBe("git");
  });
});

describe("provenance: what Sofia did vs what is merely dirty", () => {
  test("undo only inverts the turn's own files", () => {
    const set = gitSet([
      { path: "mine.ts", status: "modified", additions: 4, deletions: 1, attributedToTurn: true },
      { path: "yours.ts", status: "modified", additions: 20, deletions: 0, attributedToTurn: false },
    ]);

    expect(attributedFiles(set).map((file) => file.path)).toEqual(["mine.ts"]);
    expect(unattributedFiles(set).map((file) => file.path)).toEqual(["yours.ts"]);

    // Not undoable before the turn is settled...
    expect(canUndoChangeSet(set)).toBe(false);
    // ...and undoable once it is, because there is something of Sofia's to invert.
    expect(canUndoChangeSet(finalizeTurnChangeSet(set, 5_000))).toBe(true);
  });

  test("a turn that only saw other people's changes is not undoable", () => {
    const set = finalizeTurnChangeSet(
      gitSet([{ path: "yours.ts", status: "modified", additions: 3, deletions: 0, attributedToTurn: false }]),
      5_000,
    );
    expect(canUndoChangeSet(set)).toBe(false);
  });
});

describe("totals and titles", () => {
  test("line counts are only claimed when the source can count them", () => {
    const fromGit = gitSet();
    expect(changeSetTotals(fromGit)).toEqual({ files: 2, additions: 123, deletions: 18, countsKnown: true });

    const hints = changeSetFromToolHints({ sessionId: "s1", turnId: "t31", startedAt: 0, paths: ["a.ts", "b.ts"] });
    expect(hints && changeSetTotals(hints)).toEqual({ files: 2, additions: 0, deletions: 0, countsKnown: false });
  });

  test("titles and rows are status-aware", () => {
    const single = gitSet([{ path: "src/scroll-controller.ts", status: "modified", additions: 5, deletions: 2, attributedToTurn: true }]);
    expect(changeSetTitle(single)).toBe("Edited scroll-controller.ts");

    const renamed = gitSet([{ path: "src/new.ts", oldPath: "old.ts", status: "renamed", additions: 1, deletions: 1, attributedToTurn: true }]);
    expect(changeSetTitle(renamed)).toBe("Renamed new.ts");
    expect(fileChangeLabel(changeSetFiles(renamed)[0]!)).toBe("Renamed old.ts → new.ts");

    const binary = gitSet([{ path: "hero.png", status: "binary", additions: 0, deletions: 0, attributedToTurn: true }]);
    expect(changeSetTitle(binary)).toBe("Updated hero.png");
    expect(fileChangeNote(changeSetFiles(binary)[0]!)).toBe("Binary file");

    const many = gitSet([
      { path: "a.ts", status: "modified", additions: 1, deletions: 0, attributedToTurn: true },
      { path: "b.ts", status: "added", additions: 1, deletions: 0, attributedToTurn: true },
    ]);
    expect(changeSetTitle(many)).toBe("Edited 2 files");
  });
});

describe("git diff --numstat is the authoritative shape", () => {
  test("parses counts, binaries and renames", () => {
    const files = parseNumStat(
      [
        "51\t18\tsrc/scroll-controller.ts",
        "-\t-\tassets/hero.png",
        "3\t1\tdir/{old => new}.ts",
        "12\t4\told.ts => new.ts",
        "",
      ].join("\n"),
    );

    expect(files.map((file) => [file.path, file.status, file.additions, file.deletions])).toEqual([
      ["src/scroll-controller.ts", "modified", 51, 18],
      ["assets/hero.png", "binary", 0, 0],
      ["dir/new.ts", "renamed", 3, 1],
      ["new.ts", "renamed", 12, 4],
    ]);
    expect(files[2]?.oldPath).toBe("dir/old.ts");
    expect(files[3]?.oldPath).toBe("old.ts");
    // Everything a repository observation reports is the turn's own change.
    expect(files.every((file) => file.attributedToTurn)).toBe(true);
  });

  test("ignores blank and malformed lines", () => {
    expect(parseNumStat("\n\nnot-a-numstat-line\n")).toEqual([]);
  });
});

describe("tool events are a labelled hint, never the truth", () => {
  test("deduplicates paths and claims no counts", () => {
    const set = changeSetFromToolHints({
      sessionId: "s1",
      turnId: "t31",
      startedAt: 0,
      paths: ["a.ts", "a.ts", " b.ts ", ""],
    }) as TurnChangeSet;

    expect(set.source).toBe("tool-events");
    expect(changeSetFiles(set).map((file) => file.path)).toEqual(["a.ts", "b.ts"]);
    expect(changeSetTotals(set).countsKnown).toBe(false);
  });

  test("no paths means no change set at all", () => {
    expect(changeSetFromToolHints({ sessionId: "s1", turnId: "t31", startedAt: 0, paths: [] })).toBeNull();
  });
});
