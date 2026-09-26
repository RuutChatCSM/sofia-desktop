import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect } from "vitest";
import { test } from "@sofia/testkit";

import {
  countUntrackedLines,
  createGitRun,
  discoverRepositories,
  isGitRepository,
  readTurnDeltaForRoot,
  readWorkspaceChangesForRoot,
  resolveRepositoryRoot,
  snapshotWorkspaceTrees,
  listTurnCommits,
  readTurnDelta,
  readWorkspaceChanges,
  snapshotWorkspaceTree,
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

/**
 * The proof that a turn's change set is an artifact of the *turn*, not of the
 * repository's current dirtiness. Git alone cannot answer "what did this turn
 * change": a revision misses staged/untracked pre-existing state, and a working
 * tree diff reports nothing at all once the turn commits its own work.
 */
test("a committed turn is still reviewable, and the user's pre-existing work is not attributed to it", async () => {
  const root = makeRepo();
  try {
    // 1. Work the user had in flight before the turn: unstaged, staged, untracked.
    writeFileSync(path.join(root, "tracked.ts"), "one\ntwo\nthree\nUSER UNSTAGED\n");
    writeFileSync(path.join(root, "staged.ts"), "user staged\n");
    git(root, ["add", "staged.ts"]);
    writeFileSync(path.join(root, "untracked.txt"), "user untracked\n");
    const before = execFileSync("git", ["-C", root, "status", "--porcelain"]).toString();
    expect(before).toContain("tracked.ts");
    expect(before).toContain("staged.ts");
    expect(before).toContain("untracked.txt");

    // 2. baseline content snapshot (temp index; the user's staging is untouched)
    const baseline = await snapshotWorkspaceTree(createGitRun(root));
    expect(baseline.tree).toBeTruthy();
    expect(baseline.head).toBeTruthy();
    expect(execFileSync("git", ["-C", root, "status", "--porcelain"]).toString()).toBe(before);

    // 3. Sofia edits and adds files...
    writeFileSync(path.join(root, "sofia.ts"), "sofia one\nsofia two\n");
    writeFileSync(path.join(root, "tracked.ts"), "one\ntwo\nthree\nUSER UNSTAGED\nsofia line\n");
    // 4. ...and commits its work.
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "sofia work"]);

    // 5. The working tree is clean, so `git diff` would report nothing.
    expect(execFileSync("git", ["-C", root, "status", "--porcelain"]).toString().trim()).toBe("");

    const end = await snapshotWorkspaceTree(createGitRun(root));

    // 6. Last turn still shows the turn's exact patch, with counts.
    const delta = await readTurnDelta(createGitRun(root), {
      baselineTree: baseline.tree,
      endTree: end.tree,
      includeHunks: true,
      includePatch: true,
    });
    const commits = await listTurnCommits(createGitRun(root), {
      headBefore: baseline.head,
      headAfter: end.head,
    });

    // The turn created a commit, and the frozen patch is the turn's own delta.
    expect(commits).toHaveLength(1);
    expect(delta.patch).toContain("sofia one");
    const byPath = new Map(delta.files.map((file) => [file.path, file]));

    expect(byPath.get("sofia.ts")).toMatchObject({ status: "added", additions: 2, deletions: 0 });
    expect(byPath.get("tracked.ts")).toMatchObject({ status: "modified", additions: 1, deletions: 0 });
    expect(byPath.get("tracked.ts")?.hunks?.length).toBeGreaterThan(0);

    // 7. The user's pre-existing work is in the baseline, so only the line Sofia
    //    wrote moved — and untouched files do not appear at all.
    expect(byPath.has("staged.ts")).toBe(false);
    expect(byPath.has("untracked.txt")).toBe(false);
    const additions = delta.files.reduce((total, file) => total + file.additions, 0);
    expect(additions).toBe(3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * A brand-new project has no HEAD, so a baseline that seeds from a revision
 * cannot exist. The snapshot must still describe the files on disk, or the very
 * first turn of a new repository would have no change set at all.
 */
test("an unborn repository still gets a baseline snapshot", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "sofia-unborn-"));
  try {
    git(root, ["init", "-q"]);
    writeFileSync(path.join(root, "first.ts"), "one\n");

    const baseline = await snapshotWorkspaceTree(createGitRun(root));
    expect(baseline.tree).toBeTruthy();
    expect(baseline.head).toBeNull();

    writeFileSync(path.join(root, "first.ts"), "one\ntwo\n");
    writeFileSync(path.join(root, "second.ts"), "new file\n");
    const end = await snapshotWorkspaceTree(createGitRun(root));

    const delta = await readTurnDelta(createGitRun(root), {
      baselineTree: baseline.tree,
      endTree: end.tree,
    });
    const byPath = new Map(delta.files.map((file) => [file.path, file]));

    expect(byPath.get("first.ts")).toMatchObject({ status: "modified", additions: 1 });
    expect(byPath.get("second.ts")).toMatchObject({ status: "added", additions: 1 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * A workspace may *be* a repository, or a folder of them. Assuming the root is a
 * repository is why a multi-checkout workspace produced no diff at all: every git
 * call failed at the root and the turn fell back to a list of touched files.
 */
test("a workspace that is a folder of repositories is read per repository", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "sofia-workspace-root-"));
  try {
    const alpha = path.join(root, "alpha");
    const beta = path.join(root, "beta");
    for (const directory of [alpha, beta]) {
      mkdirSync(directory);
      git(directory, ["init", "-q"]);
      git(directory, ["config", "user.email", "eval@example.com"]);
      git(directory, ["config", "user.name", "Eval"]);
      writeFileSync(path.join(directory, "src-index.ts"), "one\n");
      git(directory, ["add", "-A"]);
      git(directory, ["commit", "-q", "-m", "init"]);
    }

    // The workspace root itself is not a repository.
    expect(await isGitRepository(root)).toBe(false);

    writeFileSync(path.join(alpha, "src-index.ts"), "one\ntwo\n");
    writeFileSync(path.join(beta, "src-index.ts"), "one\ntwo\nthree\n");

    const changes = await readWorkspaceChangesForRoot(root, { includeHunks: true });

    expect(changes.repositories.map((repository) => repository.repositoryId).sort()).toEqual(["alpha", "beta"]);
    expect(changes.repositories.find((repository) => repository.repositoryId === "alpha")?.files[0]).toMatchObject({
      path: "src-index.ts",
      status: "modified",
      additions: 1,
    });
    // Both checkouts contain the same path, and they stay separate files.
    expect(
      changes.repositories.filter((repository) => repository.files.some((file) => file.path === "src-index.ts")),
    ).toHaveLength(2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * The acceptance criterion for Last turn in a folder of repositories: the turn's
 * own work is present even when it commits, and work that was already in the
 * tree when the turn began is not attributed to it.
 */
test("a turn's patch is per repository, and pre-existing work is not attributed to it", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "sofia-multi-turn-"));
  try {
    const alpha = path.join(root, "alpha");
    const beta = path.join(root, "beta");
    for (const directory of [alpha, beta]) {
      mkdirSync(directory);
      git(directory, ["init", "-q"]);
      git(directory, ["config", "user.email", "eval@example.com"]);
      git(directory, ["config", "user.name", "Eval"]);
      writeFileSync(path.join(directory, "tracked.ts"), "one\n");
      git(directory, ["add", "-A"]);
      git(directory, ["commit", "-q", "-m", "init"]);
    }

    // Work in flight before the turn: unstaged in alpha, staged in alpha.
    writeFileSync(path.join(alpha, "tracked.ts"), "one\nuser unstaged\n");
    writeFileSync(path.join(alpha, "staged.ts"), "user staged\n");
    git(alpha, ["add", "staged.ts"]);

    const baselines = await snapshotWorkspaceTrees(root);
    expect(baselines.map((baseline) => baseline.repositoryId).sort()).toEqual(["alpha", "beta"]);
    expect(baselines.every((baseline) => baseline.tree.length > 0)).toBe(true);

    // The turn edits beta, adds a file and commits it.
    writeFileSync(path.join(beta, "sofia.ts"), "sofia one\nsofia two\n");
    writeFileSync(path.join(beta, "tracked.ts"), "one\nsofia line\n");
    git(beta, ["add", "-A"]);
    git(beta, ["commit", "-q", "-m", "sofia work"]);
    expect(execFileSync("git", ["-C", beta, "status", "--porcelain"]).toString().trim()).toBe("");

    const delta = await readTurnDeltaForRoot(root, baselines, { includeHunks: true, includePatch: true });
    const byId = new Map(delta.repositories.map((repository) => [repository.repositoryId, repository]));

    // beta: committed work is still the turn's patch.
    expect(byId.get("beta")?.files.map((file) => file.path).sort()).toEqual(["sofia.ts", "tracked.ts"]);
    // sofia.ts (2 lines) + tracked.ts (1 line).
    expect(byId.get("beta")?.files.reduce((total, file) => total + file.additions, 0)).toBe(3);
    // The turn's trees and the commit it created are recorded per repository, and
    // the frozen patch is replay-grade (full index, so it applies against blobs).
    expect(byId.get("beta")?.baselineTree).toBeTruthy();
    expect(byId.get("beta")?.endTree).not.toBe(byId.get("beta")?.baselineTree);
    expect(byId.get("beta")?.patch).toContain("diff --git");
    expect(byId.get("beta")?.patch).toContain("index ");
    expect(byId.get("beta")?.commitsInRange).toHaveLength(1);

    // alpha: untouched by the turn, so its dirty and staged work is not the turn's.
    expect(byId.get("alpha")?.files).toEqual([]);
    expect(byId.get("alpha")?.unavailable).toBeUndefined();
    // Nothing in alpha happened during the turn, so it has no patch of its own.
    expect(byId.get("alpha")?.patch).toBeUndefined();
    expect(byId.get("alpha")?.commitsInRange).toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("discovery resolves the canonical repository root and dedupes", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "sofia-discover-"));
  try {
    const repository = path.join(root, "repo");
    mkdirSync(repository);
    git(repository, ["init", "-q"]);
    const nested = path.join(repository, "packages", "inner");
    mkdirSync(nested, { recursive: true });

    const canonical = realpathSync(repository);
    // A nested directory belongs to the repository that owns it, not to itself.
    expect(await resolveRepositoryRoot(nested)).toBe(canonical);
    expect(await discoverRepositories(nested)).toEqual([canonical]);
    expect(await discoverRepositories(root)).toEqual([canonical]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a linked worktree is its own repository, found by toplevel rather than by .git being a directory", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "sofia-worktree-"));
  try {
    const repository = path.join(root, "repo");
    mkdirSync(repository);
    git(repository, ["init", "-q"]);
    git(repository, ["config", "user.email", "eval@example.com"]);
    git(repository, ["config", "user.name", "Eval"]);
    writeFileSync(path.join(repository, "tracked.ts"), "one\n");
    git(repository, ["add", "-A"]);
    git(repository, ["commit", "-q", "-m", "init"]);

    const worktree = path.join(root, "repo-worktree");
    git(repository, ["worktree", "add", "-q", worktree]);

    // `.git` here is a *file* pointing at the main checkout. A filesystem check
    // for a `.git` directory would never see this repository at all.
    expect(statSync(path.join(worktree, ".git")).isFile()).toBe(true);

    const canonicalWorktree = realpathSync(worktree);
    expect(await resolveRepositoryRoot(worktree)).toBe(canonicalWorktree);
    expect((await discoverRepositories(root)).sort()).toEqual(
      [realpathSync(repository), canonicalWorktree].sort(),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
