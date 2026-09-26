import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";

import {
  countUntrackedLines,
  parseNameStatusZ,
  parseNumStatZ,
  parsePorcelainV2,
  parseUnifiedDiff,
  readWorkspaceChanges,
  type GitRun,
  type GitResult,
} from "./git-changes.js";

describe("git status --porcelain=v2 -z", () => {
  test("reads modifications, additions, deletions and untracked files", () => {
    const output = [
      "1 .M N... 100644 100644 100644 aaaa bbbb src/modified.ts",
      "1 A. N... 000000 100644 100644 0000 cccc src/added.ts",
      "1 .D N... 100644 100644 000000 dddd 0000 src/deleted.ts",
      "? src/untracked.ts",
      "",
    ].join("\0");

    expect(parsePorcelainV2(output)).toEqual([
      { path: "src/modified.ts", status: "modified" },
      { path: "src/added.ts", status: "added" },
      { path: "src/deleted.ts", status: "deleted" },
      { path: "src/untracked.ts", status: "added" },
    ]);
  });

  test("resolves a rename from the following NUL-terminated entry", () => {
    const output = ["2 R. N... 100644 100644 100644 eeee ffff R100 src/new.ts", "src/old.ts", ""].join("\0");

    expect(parsePorcelainV2(output)).toEqual([{ path: "src/new.ts", oldPath: "src/old.ts", status: "renamed" }]);
  });

  test("keeps paths containing spaces intact", () => {
    const output = ["1 .M N... 100644 100644 100644 aaaa bbbb docs/my notes.md", ""].join("\0");
    expect(parsePorcelainV2(output)[0]?.path).toBe("docs/my notes.md");
  });
});

describe("git diff --name-status -z", () => {
  test("reads the NUL-separated status/path fields", () => {
    // `A\0path\0M\0path2\0D\0path3\0`
    const output = ["A", "src/added.ts", "M", "src/modified.ts", "D", "src/deleted.ts", ""].join("\0");

    expect(parseNameStatusZ(output)).toEqual([
      { path: "src/added.ts", status: "added" },
      { path: "src/modified.ts", status: "modified" },
      { path: "src/deleted.ts", status: "deleted" },
    ]);
  });

  test("reads a rename as status, old path, new path", () => {
    const output = ["R100", "src/old.ts", "src/new.ts", ""].join("\0");

    expect(parseNameStatusZ(output)).toEqual([
      { path: "src/new.ts", oldPath: "src/old.ts", status: "renamed" },
    ]);
  });

  test("empty output yields nothing", () => {
    expect(parseNameStatusZ("")).toEqual([]);
  });
});

describe("git diff --numstat -z", () => {
  test("reads counts, binaries and renames", () => {
    const output = ["51\t18\tsrc/scroll.ts", "-\t-\tassets/hero.png", "3\t1\t", "src/new.ts", ""].join("\0");
    const stats = parseNumStatZ(output);

    expect(stats.get("src/scroll.ts")).toEqual({ additions: 51, deletions: 18, binary: false });
    expect(stats.get("assets/hero.png")).toEqual({ additions: 0, deletions: 0, binary: true });
    // Renames carry the new path in the following entry.
    expect(stats.get("src/new.ts")).toEqual({ additions: 3, deletions: 1, binary: false });
  });
});

describe("git diff --unified", () => {
  test("collects hunks per file, including a deletion", () => {
    const output = [
      "diff --git a/src/a.ts b/src/a.ts",
      "index 111..222 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,3 +1,4 @@",
      " context",
      "-old",
      "+new",
      "+more",
      "@@ -20,2 +21,2 @@ function x()",
      "-a",
      "+b",
      "diff --git a/src/gone.ts b/src/gone.ts",
      "--- a/src/gone.ts",
      "+++ /dev/null",
      "@@ -1,1 +0,0 @@",
      "-bye",
      "",
    ].join("\n");

    const hunks = parseUnifiedDiff(output);

    expect(hunks.get("src/a.ts")).toHaveLength(2);
    expect(hunks.get("src/a.ts")?.[0]).toMatchObject({ oldStart: 1, oldLines: 3, newStart: 1, newLines: 4 });
    expect(hunks.get("src/a.ts")?.[1]?.lines).toEqual([
      { type: "delete", oldLine: 20, text: "a" },
      { type: "add", newLine: 21, text: "b" },
    ]);
    // `+++ /dev/null` keeps the previous path so deletions still get their hunks.
    expect(hunks.get("src/gone.ts")).toHaveLength(1);
  });
});

describe("readWorkspaceChanges", () => {
  function fakeRun(outputs: Record<string, GitResult>): GitRun {
    return async (args: string[]) => outputs[args.join(" ")] ?? { stdout: "", code: 0 };
  }

  test("merges status, counts, hunks and the revision", async () => {
    const run = fakeRun({
      "rev-parse --short HEAD": { stdout: "abc1234\n", code: 0 },
      "status --porcelain=v2 -z --untracked-files=all": {
        stdout: ["1 .M N... 100644 100644 100644 aaaa bbbb src/modified.ts", "? src/untracked.ts", ""].join("\0"),
        code: 0,
      },
      "diff --numstat -z": { stdout: "4\t1\tsrc/modified.ts\0", code: 0 },
      "diff --unified=3 --no-color": {
        stdout: "+++ b/src/modified.ts\n@@ -1,2 +1,3 @@\n-a\n+b\n+c\n",
        code: 0,
      },
    });

    const snapshot = await readWorkspaceChanges(run, { includeHunks: true });

    expect(snapshot.revision).toBe("abc1234");
    expect(snapshot.files).toEqual([
      {
        path: "src/modified.ts",
        status: "modified",
        additions: 4,
        deletions: 1,
        hunks: [
          {
            header: "@@ -1,2 +1,3 @@",
            oldStart: 1,
            oldLines: 2,
            newStart: 1,
            newLines: 3,
            lines: [
              { type: "delete", oldLine: 1, text: "a" },
              { type: "add", newLine: 1, text: "b" },
              { type: "add", newLine: 2, text: "c" },
            ],
          },
        ],
      },
      { path: "src/untracked.ts", status: "added", additions: 0, deletions: 0 },
    ]);
  });

  test("a non-repository (or empty diff) yields no changes rather than an error", async () => {
    const run = fakeRun({
      "rev-parse --short HEAD": { stdout: "", code: 128 },
      "status --porcelain=v2 -z --untracked-files=all": { stdout: "", code: 0 },
    });

    expect(await readWorkspaceChanges(run)).toEqual({ revision: null, files: [] });
  });

  test("binary changes are marked, not counted", async () => {
    const run = fakeRun({
      "rev-parse --short HEAD": { stdout: "abc\n", code: 0 },
      "status --porcelain=v2 -z --untracked-files=all": {
        stdout: "1 .M N... 100644 100644 100644 aaaa bbbb hero.png\u0000",
        code: 0,
      },
      "diff --numstat -z": { stdout: "-\t-\thero.png\0", code: 0 },
    });

    expect((await readWorkspaceChanges(run)).files[0]).toMatchObject({ path: "hero.png", status: "binary", additions: 0, deletions: 0 });
  });
});

describe("untracked files are counted from the bytes", () => {
  test("counts lines, refuses binary, tolerates a missing file", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sofia-git-changes-"));
    await writeFile(path.join(root, "notes.txt"), "one\ntwo\nthree\n");
    await writeFile(path.join(root, "blob.bin"), "a\u0000b");

    const files = await countUntrackedLines(root, [
      { path: "notes.txt", status: "added", additions: 0, deletions: 0 },
      { path: "blob.bin", status: "added", additions: 0, deletions: 0 },
      { path: "missing.txt", status: "added", additions: 0, deletions: 0 },
    ]);

    expect(files[0]).toMatchObject({ additions: 3 });
    expect(files[1]).toMatchObject({ status: "binary" });
    expect(files[2]).toMatchObject({ additions: 0 });
  });
});
