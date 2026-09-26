/** @jsxImportSource react */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { TurnChangeSetCard } from "../src/react-app/domains/session/changes/turn-change-set-card";
import { changeSetFiles } from "../src/react-app/domains/session/changes/turn-change-set";
import { changeSetFromToolHints } from "../src/react-app/domains/session/changes/change-set-from-messages";
import {
  beginTurnChangeSet,
  finalizeTurnChangeSet,
  parseNumStat,
  reconcileTurnChangeSet,
  type ChangeSetSource,
} from "../src/react-app/domains/session/changes/turn-change-set";

function changeSet(source: ChangeSetSource, files: ReturnType<typeof parseNumStat>) {
  const started = beginTurnChangeSet({ sessionId: "s1", turnId: "t31", startedAt: 1_000 });
  const observed = reconcileTurnChangeSet(started, {
    source,
    repositories: [{ repositoryId: "repo-1", root: "/repo", files }],
  });
  return finalizeTurnChangeSet(observed, 5_000);
}

describe("an empty repository read never hides the hint card", () => {
  test("files from tool events still render when the turn committed its work", () => {
    // Regression: a turn that commits its own changes reads as an empty working
    // tree at turn end, and that empty set used to shadow the hints entirely, so
    // no card appeared at all after the narration.
    const hints = changeSetFromToolHints({
      sessionId: "s1",
      turnId: "t31",
      startedAt: 0,
      paths: ["approval-mode-selector.tsx"],
    });
    expect(hints).not.toBeNull();
    expect(changeSetFiles(hints!)).toHaveLength(1);

    const empty: ReturnType<typeof changeSetFromToolHints> = null;
    // The card renders from whichever set has files.
    expect(changeSetFiles(hints!).length > 0).toBe(true);
    expect(empty).toBeNull();
  });
});

describe("result card", () => {
  test("summarises the turn's patch and addresses it by change set id", () => {
    const markup = renderToStaticMarkup(
      <TurnChangeSetCard
        changeSet={changeSet(
          "git",
          parseNumStat("51\t18\tscroll-controller.ts\n72\t0\tclipboard-payload.ts"),
        )}
      />,
    );

    expect(markup).toContain('data-turn-changeset="turn:s1:t31"');
    expect(markup).toContain('data-changeset-source="git"');
    expect(markup).toContain("Edited 2 files");
    expect(markup).toContain("+123");
    expect(markup).toContain("−18");
    // Per-file rows, with their own counts.
    expect(markup).toContain("scroll-controller.ts");
    expect(markup).toContain("+51");
  });

  test("invents no numbers when the source cannot count lines", () => {
    const markup = renderToStaticMarkup(
      <TurnChangeSetCard changeSet={changeSet("tool-events", parseNumStat("0\t0\ta.ts\n0\t0\tb.ts"))} />,
    );

    expect(markup).toContain('data-changeset-source="tool-events"');
    expect(markup).toContain("Edited 2 files");
    expect(markup).not.toContain("+0");
    expect(markup).not.toContain("−0");
    // The absence is stated rather than left looking like a zero-sized change.
    expect(markup).toContain("data-changeset-unmeasured");
    expect(markup).toContain("Change size unavailable for this older turn.");
  });

  test("folds the tail of a long list behind Show N more", () => {
    const files = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"].map((path) => `1\t1\t${path}`).join("\n");
    const markup = renderToStaticMarkup(<TurnChangeSetCard changeSet={changeSet("git", parseNumStat(files))} />);

    expect(markup).toContain("Show 2 more");
  });

  test("a multi-repository turn labels each row", () => {
    const started = beginTurnChangeSet({ sessionId: "s1", turnId: "t31", startedAt: 0 });
    const multi = finalizeTurnChangeSet(
      reconcileTurnChangeSet(started, {
        source: "git",
        repositories: [
          { repositoryId: "sofia-app", root: "/a", files: [
            { path: "src/index.ts", status: "modified", additions: 4, deletions: 1, attributedToTurn: true },
          ] },
          { repositoryId: "sofia", root: "/b", files: [
            { path: "src/index.ts", status: "modified", additions: 2, deletions: 0, attributedToTurn: true },
          ] },
        ],
      }),
      5_000,
    );

    const markup = renderToStaticMarkup(<TurnChangeSetCard changeSet={multi} />);

    expect(markup).toContain("sofia-app/");
    expect(markup).toContain("sofia/");
    // Single-repository turns stay unlabelled.
    expect(renderToStaticMarkup(<TurnChangeSetCard changeSet={changeSet("git", parseNumStat("1\t1\ta.ts"))} />))
      .not.toContain("workspace/");
  });

  test("shows Undo and Review only when the app can act on them", () => {
    const set = changeSet("git", parseNumStat("1\t1\ta.ts"));

    const passive = renderToStaticMarkup(<TurnChangeSetCard changeSet={set} />);
    expect(passive).not.toContain("Undo");
    expect(passive).not.toContain("Review");

    const actionable = renderToStaticMarkup(
      <TurnChangeSetCard changeSet={set} onUndo={() => {}} onReview={() => {}} />,
    );
    expect(actionable).toContain("Undo");
    expect(actionable).toContain("Review");
  });

  test("marks changes that are not Sofia's own", () => {
    const started = beginTurnChangeSet({ sessionId: "s1", turnId: "t31", startedAt: 1_000 });
    const observed = reconcileTurnChangeSet(started, {
      source: "git",
      repositories: [
        {
          repositoryId: "repo-1",
          root: "/repo",
          files: [
            { path: "mine.ts", status: "modified", additions: 4, deletions: 1, attributedToTurn: true },
            { path: "yours.ts", status: "modified", additions: 20, deletions: 0, attributedToTurn: false },
          ],
        },
      ],
    });

    const markup = renderToStaticMarkup(<TurnChangeSetCard changeSet={finalizeTurnChangeSet(observed, 5_000)} />);

    expect(markup).toContain("Not from Sofia");
  });

  test("renders nothing for a turn with no changes", () => {
    const markup = renderToStaticMarkup(<TurnChangeSetCard changeSet={changeSet("git", parseNumStat(""))} />);
    expect(markup).toBe("");
  });
});
