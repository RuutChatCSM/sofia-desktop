/** @jsxImportSource react */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ReviewPane } from "../src/react-app/domains/session/changes/review-pane";
import { changeSetFromRepository } from "../src/react-app/domains/session/changes/change-set-source";
import { changeSetFromToolHints } from "../src/react-app/domains/session/changes/change-set-from-messages";
import {
  beginTurnChangeSet,
  type TurnChangeSet as TurnChangeSetType,
  finalizeTurnChangeSet,
  reconcileTurnChangeSet,
  type FileChange,
  type TurnChangeSet,
} from "../src/react-app/domains/session/changes/turn-change-set";

const HUNKS = [
  {
    header: "@@ -184,3 +184,4 @@",
    oldStart: 184,
    oldLines: 3,
    newStart: 184,
    newLines: 4,
    lines: [
      { type: "context" as const, oldLine: 184, newLine: 184, text: "context" },
      { type: "delete" as const, oldLine: 185, text: "removed" },
      { type: "add" as const, newLine: 185, text: "added" },
      { type: "add" as const, newLine: 186, text: "more" },
    ],
  },
];

function turnChangeSet(): TurnChangeSet {
  const started = beginTurnChangeSet({ sessionId: "s1", turnId: "t31", startedAt: 1_000 });
  const observed = reconcileTurnChangeSet(started, {
    source: "git",
    repositories: [
      {
        repositoryId: "workspace",
        root: "/repo",
        files: [
          { path: "src/scroll-controller.ts", status: "modified", additions: 51, deletions: 18, hunks: HUNKS, attributedToTurn: true },
          { path: "yours.ts", status: "modified", additions: 20, deletions: 0, attributedToTurn: false },
        ],
      },
    ],
  });
  return finalizeTurnChangeSet(observed, 5_000);
}

describe("review pane", () => {
  test("renders a turn's patch: scopes, file list, hunks and provenance", () => {
    const markup = renderToStaticMarkup(
      <ReviewPane scope="last-turn" onScopeChange={() => {}} changeSet={turnChangeSet()} />,
    );

    expect(markup).toContain('data-review-pane="last-turn"');
    // Scopes are switchable; the active one is marked.
    expect(markup).toContain('data-review-scope="last-turn"');
    expect(markup).toContain('data-review-scope="unstaged"');
    expect(markup).toContain('data-review-scope="staged"');
    expect(markup).toContain('aria-pressed="true"');

    // File list, with the turn's own change selected first.
    expect(markup).toContain('data-review-file="src/scroll-controller.ts"');
    expect(markup).toContain('data-review-file="yours.ts"');
    // Pre-existing work is labelled, not silently claimed.
    expect(markup).toContain("not Sofia");

    // The diff itself, side by side, with real line numbers on both sides.
    expect(markup).toContain("@@ -184,3 +184,4 @@");
    expect(markup).toContain('data-diff-side="old"');
    expect(markup).toContain('data-diff-side="new"');
    expect(markup).toContain('data-diff-line="add"');
    expect(markup).toContain('data-diff-line="delete"');
    expect(markup).toContain('data-diff-line="context"');
    // Old line 185 (the removal) is paired with new line 185 (its replacement);
    // the extra addition has a blank old side.
    expect(markup).toContain(">185<");
    expect(markup).toContain(">186<");
    expect(markup).toContain("+added");
    expect(markup).toContain("data-diff-blank");
  });

  test("the other scopes read the live working tree instead of a turn", () => {
    const files: FileChange[] = [
      { path: "loose.ts", status: "modified", additions: 2, deletions: 1, attributedToTurn: true },
    ];

    const markup = renderToStaticMarkup(
      <ReviewPane scope="unstaged" onScopeChange={() => {}} repositoryFiles={files} />,
    );

    expect(markup).toContain('data-review-pane="unstaged"');
    expect(markup).toContain('data-review-file="loose.ts"');
    // A live scope has no turn summary to show.
    expect(markup).not.toContain("Edited 2 files");
  });

  test("multiple repositories are grouped, and long unchanged stretches collapse", () => {
    const started = beginTurnChangeSet({ sessionId: "s1", turnId: "t31", startedAt: 0 });
    const multi = finalizeTurnChangeSet(
      reconcileTurnChangeSet(started, {
        source: "git",
        repositories: [
          {
            repositoryId: "sofia-app",
            root: "/a",
            files: [
              {
                path: "src/index.ts",
                status: "modified",
                additions: 4,
                deletions: 1,
                attributedToTurn: true,
                hunks: [
                  { header: "@@ -1,3 +1,4 @@", oldStart: 1, oldLines: 3, newStart: 1, newLines: 4, lines: [
                    { type: "context", oldLine: 1, newLine: 1, text: "keep" },
                    { type: "add", newLine: 2, text: "added" },
                  ] },
                  { header: "@@ -66,2 +67,2 @@", oldStart: 66, oldLines: 2, newStart: 67, newLines: 2, lines: [
                    { type: "delete", oldLine: 66, text: "old" },
                    { type: "add", newLine: 67, text: "new" },
                  ] },
                ],
              },
            ],
          },
          { repositoryId: "sofia", root: "/b", files: [
            { path: "src/index.ts", status: "modified", additions: 2, deletions: 0, attributedToTurn: true },
          ] },
        ],
      }),
      5_000,
    );

    const markup = renderToStaticMarkup(<ReviewPane scope="last-turn" onScopeChange={() => {}} changeSet={multi} />);

    // Two repositories, both with `src/index.ts`, rendered as two groups.
    expect(markup).toContain('data-review-repository="sofia-app"');
    expect(markup).toContain('data-review-repository="sofia"');
    expect((markup.match(/data-review-file="src\/index.ts"/g) ?? []).length).toBe(2);

    // The 62-line stretch between the two hunks is summarised, not printed.
    expect(markup).toContain("62 unchanged lines");
  });

  test("an unmeasured turn never claims +0 -0 and explains the empty diff", () => {
    // What the pane looked like for a hint-sourced turn: every file at "+0 −0"
    // and "No textual diff available", which reads as a defect rather than "the
    // repository was not read".
    const hints = changeSetFromToolHints({
      sessionId: "s1",
      turnId: "t31",
      startedAt: 0,
      paths: ["session-surface.tsx"],
    });
    const markup = renderToStaticMarkup(
      <ReviewPane scope="last-turn" onScopeChange={() => {}} changeSet={hints as TurnChangeSetType} />,
    );

    expect(markup).not.toContain("+0");
    expect(markup).not.toContain("−0");
    expect(markup).toContain("was not read from the repository");
    // The files Sofia touched are still listed.
    expect(markup).toContain('data-review-file="session-surface.tsx"');
  });

  test("an unattributed set is not headed as the turn's own change", () => {
    // No baseline was captured, so the read is the repository's current state.
    // The pane must not print its counts under "Last turn".
    const set = changeSetFromRepository({
      sessionId: "s1",
      turnId: "t31",
      startedAt: 0,
      baseline: null,
      snapshot: {
        revision: null,
        files: [],
        repositories: [
          {
            repositoryId: "workspace",
            root: "/repo",
            revision: "r1",
            files: [{ path: "yours.ts", status: "modified", additions: 20, deletions: 3 }],
          },
        ],
      },
      attributionUnavailable: true,
      finalizedAt: 5_000,
    });

    const markup = renderToStaticMarkup(<ReviewPane scope="last-turn" onScopeChange={() => {}} changeSet={set} />);

    expect(markup).toContain("Working-tree changes");
    expect(markup).not.toContain("+20");
    expect(markup).toContain("was not read from the repository");
  });

  test("says so when a scope has nothing, and while it is loading", () => {
    expect(
      renderToStaticMarkup(<ReviewPane scope="staged" onScopeChange={() => {}} repositoryFiles={[]} />),
    ).toContain("No changes in this scope.");

    expect(
      renderToStaticMarkup(<ReviewPane scope="staged" onScopeChange={() => {}} repositoryFiles={[]} loading />),
    ).toContain("Reading the working tree…");
  });
});
