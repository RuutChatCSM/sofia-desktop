import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect } from "vitest";
import { test } from "@sofia/testkit";

import {
  countUntrackedLines,
  createGitRun,
  readWorkspaceChanges,
} from "../../apps/server/src/git-changes.ts";

function git(root: string, args: string[]) {
  execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
}

function makeRepo(): string {
  const root = mkdtempSync(path.join(tmpdir(), "sofia-workspace-changes-"));
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "eval@example.com"]);
  git(root, ["config", "user.name", "Eval"]);
  writeFileSync(path.join(root, "tracked.ts"), "one\ntwo\nthree\n");
  writeFileSync(path.join(root, "gone.ts"), "bye\n");
  writeFileSync(path.join(root, "old-name.ts"), "rename me\n");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "init"]);
  return root;
}

/**
 * The change summary must come from repository state, not from the model's edit
 * events: a shell command, a formatter, a script or an MCP tool can write files
 * with no apply_patch anywhere. This drives real git to prove it.
 */
test("workspace changes are read from the repository, whoever wrote them", async () => {
  const root = makeRepo();
  try {
    // A shell-style edit (no edit tool involved), an added file, a deletion and
    // a rename — every mechanism that never shows up as an apply_patch event.
    writeFileSync(path.join(root, "tracked.ts"), "one\nCHANGED\nthree\n");
    writeFileSync(path.join(root, "untracked.txt"), "brand\nnew\nfile\n");
    rmSync(path.join(root, "gone.ts"));
    git(root, ["mv", "old-name.ts", "new-name.ts"]);

    const snapshot = await readWorkspaceChanges(createGitRun(root), { includeHunks: true });
    const byPath = new Map(snapshot.files.map((file) => [file.path, file]));

    expect(snapshot.revision).toBeTruthy();
    expect(snapshot.files.length).toBeGreaterThan(0);

    // The one-line edit is counted from the real diff.
    expect(byPath.get("tracked.ts")).toMatchObject({ status: "modified", additions: 1, deletions: 1 });
    expect(byPath.get("tracked.ts")?.hunks?.length).toBeGreaterThan(0);
    expect(byPath.get("gone.ts")?.status).toBe("deleted");
    expect(byPath.get("new-name.ts")).toMatchObject({ status: "renamed", oldPath: "old-name.ts" });

    // Untracked files are absent from `git diff`, so their size comes from the
    // bytes on disk rather than being reported as an empty change.
    expect(byPath.get("untracked.txt")).toMatchObject({ status: "added", additions: 0 });
    const counted = await countUntrackedLines(root, snapshot.files);
    expect(counted.find((file) => file.path === "untracked.txt")?.additions).toBe(3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a directory that is not a repository reports no changes rather than failing", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "sofia-workspace-no-git-"));
  try {
    // A real, existing, non-repository directory (not a deleted one, which would
    // "pass" this assertion for the wrong reason).
    writeFileSync(path.join(root, "loose.txt"), "not a repo\n");
    expect(await readWorkspaceChanges(createGitRun(root))).toEqual({ revision: null, files: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
