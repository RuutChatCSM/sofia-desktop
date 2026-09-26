/** @jsxImportSource react */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ReviewPane } from "../src/react-app/domains/session/changes/review-pane";
import {
  beginTurnChangeSet,
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

    // The diff itself, with real line numbers on both sides.
    expect(markup).toContain("@@ -184,3 +184,4 @@");
    expect(markup).toContain('data-diff-line="add"');
    expect(markup).toContain('data-diff-line="delete"');
    expect(markup).toContain('data-diff-line="context"');
    // Old side line 185 is the removal; the new side starts the addition at 185.
    expect(markup).toContain(">185<");
    expect(markup).toContain(">186<");
    expect(markup).toContain("+added");
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

  test("says so when a scope has nothing, and while it is loading", () => {
    expect(
      renderToStaticMarkup(<ReviewPane scope="staged" onScopeChange={() => {}} repositoryFiles={[]} />),
    ).toContain("No changes in this scope.");

    expect(
      renderToStaticMarkup(<ReviewPane scope="staged" onScopeChange={() => {}} repositoryFiles={[]} loading />),
    ).toContain("Reading the working tree…");
  });
});
