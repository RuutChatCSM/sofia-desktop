import { describe, expect, test } from "bun:test";

import { changeSetFromToolHints } from "../src/react-app/domains/session/changes/change-set-from-messages";
import {
  attributeFilesToTurn,
  baselineFromChanges,
  changeSetFromRepository,
} from "../src/react-app/domains/session/changes/change-set-source";
import {
  selectTurnChangeSet,
  useChangeSetStore,
} from "../src/react-app/domains/session/changes/change-set-store";
import { changeSetTotals, isFrozen } from "../src/react-app/domains/session/changes/turn-change-set";

const DIRTY_BEFORE = { path: "yours.ts", status: "modified" as const, additions: 20, deletions: 0 };

describe("attribution: what Sofia did vs what was already dirty", () => {
  test("a file that was already dirty with unchanged counts is not the turn's", () => {
    const baseline = baselineFromChanges({ revision: "abc", files: [DIRTY_BEFORE] });

    const [file] = attributeFilesToTurn({
      baseline,
      files: [DIRTY_BEFORE, { path: "mine.ts", status: "modified", additions: 4, deletions: 1 }],
    });

    expect(file).toMatchObject({ path: "yours.ts", attributedToTurn: false, additions: 20 });
  });

  test("a file the turn also edited is attributed, even if it was dirty before", () => {
    const baseline = baselineFromChanges({ revision: "abc", files: [DIRTY_BEFORE] });

    const [file] = attributeFilesToTurn({
      baseline,
      files: [{ path: "yours.ts", status: "modified", additions: 26, deletions: 0 }],
    });

    expect(file?.attributedToTurn).toBe(true);
  });

  test("without a baseline nothing is claimed as the user's own", () => {
    const [file] = attributeFilesToTurn({ baseline: null, files: [DIRTY_BEFORE] });
    expect(file?.attributedToTurn).toBe(true);
  });
});

describe("a finished turn's change set comes from the repository", () => {
  test("is git-sourced, counted, renamed-aware and frozen", () => {
    const changeSet = changeSetFromRepository({
      sessionId: "s1",
      turnId: "t31",
      startedAt: 1_000,
      baseline: baselineFromChanges({ revision: "before", files: [] }),
      snapshot: {
        revision: "after",
        files: [
          { path: "src/scroll.ts", status: "modified", additions: 51, deletions: 18 },
          { path: "src/new.ts", oldPath: "src/old.ts", status: "renamed", additions: 3, deletions: 1 },
        ],
      },
      finalizedAt: 5_000,
    });

    expect(changeSet.id).toBe("turn:s1:t31");
    expect(changeSet.source).toBe("git");
    expect(isFrozen(changeSet)).toBe(true);
    expect(changeSet.repositories[0]?.baseRevision).toBe("after");
    expect(changeSetTotals(changeSet)).toEqual({ files: 2, additions: 54, deletions: 19, countsKnown: true });
    expect(changeSetTotals(changeSet).countsKnown).toBe(true);
  });
});

describe("re-registering the same set must not notify", () => {
  test("a rebuilt but identical hint set is a no-op", () => {
    // Regression: the hint registration runs from a render-adjacent effect and
    // rebuilds its object every render. Treating that as a change notified
    // subscribers, which re-rendered, which rebuilt the object — a render loop
    // that crashed the session view.
    const store = useChangeSetStore.getState();
    store.clear();
    let notifications = 0;
    const unsubscribe = useChangeSetStore.subscribe(() => {
      notifications += 1;
    });

    const build = () =>
      changeSetFromToolHints({
        sessionId: "s1",
        turnId: "t31",
        startedAt: 1_000,
        paths: ["a.ts", "b.ts"],
      });

    useChangeSetStore.getState().upsert(build()!);
    const afterFirst = useChangeSetStore.getState().byId["turn:s1:t31"];
    useChangeSetStore.getState().upsert(build()!);
    useChangeSetStore.getState().upsert(build()!);

    expect(notifications).toBe(1);
    expect(useChangeSetStore.getState().byId["turn:s1:t31"]).toBe(afterFirst);

    unsubscribe();
    useChangeSetStore.getState().clear();
  });
});

describe("the store keeps a turn's patch immutable", () => {
  test("a second observation cannot rewrite a finalized turn", () => {
    const store = useChangeSetStore.getState();
    store.clear();

    const first = changeSetFromRepository({
      sessionId: "s1",
      turnId: "t31",
      startedAt: 1_000,
      baseline: null,
      snapshot: { revision: "a", files: [{ path: "a.ts", status: "modified", additions: 1, deletions: 0 }] },
      finalizedAt: 5_000,
    });
    useChangeSetStore.getState().upsert(first);

    const later = changeSetFromRepository({
      sessionId: "s1",
      turnId: "t31",
      startedAt: 1_000,
      baseline: null,
      snapshot: { revision: "b", files: [{ path: "something-else.ts", status: "modified", additions: 99, deletions: 99 }] },
      finalizedAt: 9_000,
    });
    useChangeSetStore.getState().upsert(later);

    const stored = selectTurnChangeSet(useChangeSetStore.getState().byId, "s1", "t31");
    expect(stored?.repositories[0]?.files.map((file) => file.path)).toEqual(["a.ts"]);
    expect(stored?.finalizedAt).toBe(5_000);

    // An unknown turn simply has no set.
    expect(selectTurnChangeSet(useChangeSetStore.getState().byId, "s1", "t32")).toBeNull();
    useChangeSetStore.getState().clear();
  });
});
