/**
 * Authoritative change observation for a workspace.
 *
 * The transcript's change summary must reflect *repository state*, not the
 * model's edit events: a shell command, a formatter, a script or an MCP tool can
 * write files with no `apply_patch` anywhere in sight. Everything here is
 * derived from `git` (plus, for untracked files, the bytes on disk), so whoever
 * wrote the change is irrelevant to the result.
 *
 * Parsing is separated from process execution (`GitRun`) so the formats are
 * unit-testable and the reader is exercisable against a real temporary repo.
 */
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";

export type ChangeStatus = "added" | "modified" | "deleted" | "renamed" | "binary";

/**
 * A structured diff line. The viewer needs real line numbers on both sides to
 * render gutters, anchors for inline comments, and red/green rows — trying to
 * re-derive those from formatted git text is how diff viewers end up wrong.
 */
export type DiffLine = {
  type: "context" | "add" | "delete";
  oldLine?: number;
  newLine?: number;
  /** The line's text, without the leading ' ', '+' or '-'. */
  text: string;
};

export type DiffHunk = {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
};

export type WorkspaceFileChange = {
  path: string;
  oldPath?: string;
  status: ChangeStatus;
  additions: number;
  deletions: number;
  hunks?: DiffHunk[];
};

export type WorkspaceChangeSnapshot = {
  /** Short HEAD revision the working tree is measured against, when resolvable. */
  revision: string | null;
  files: WorkspaceFileChange[];
};

/**
 * Which slice of the repository to read. `unstaged` is the working tree (what a
 * turn typically leaves behind, untracked files included); `staged` is the index.
 */
export type ChangeScope = "unstaged" | "staged";

export type GitResult = { stdout: string; code: number };
export type GitRun = (args: string[], env?: Record<string, string>) => Promise<GitResult>;

/** `git status --porcelain=v2 -z` → status entries, renames resolved. */
export function parsePorcelainV2(output: string): Array<{ path: string; oldPath?: string; status: ChangeStatus }> {
  const entries = output.split("\0");
  const changes: Array<{ path: string; oldPath?: string; status: ChangeStatus }> = [];

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) continue;

    if (entry.startsWith("? ")) {
      changes.push({ path: entry.slice(2), status: "added" });
      continue;
    }
    if (entry.startsWith("1 ")) {
      // 1 XY sub mH mI mW hH hI <path>
      const fields = entry.split(" ");
      const xy = fields[1] ?? "";
      const filePath = fields.slice(8).join(" ");
      if (!filePath) continue;
      changes.push({ path: filePath, status: statusFromXY(xy) });
      continue;
    }
    if (entry.startsWith("2 ")) {
      // 2 XY sub mH mI mW hH hI Xscore <path>\0<oldPath>
      const fields = entry.split(" ");
      const xy = fields[1] ?? "";
      const filePath = fields.slice(9).join(" ");
      const oldPath = entries[index + 1] ?? "";
      index += 1;
      if (!filePath) continue;
      changes.push({
        path: filePath,
        ...(oldPath ? { oldPath } : {}),
        status: xy.includes("R") || xy.includes("C") ? "renamed" : statusFromXY(xy),
      });
    }
  }

  return changes;
}

function statusFromXY(xy: string): ChangeStatus {
  if (xy.includes("D")) return "deleted";
  if (xy.includes("A")) return "added";
  return "modified";
}

/**
 * `git diff --name-status -z` → status per path.
 *
 * With `-z` git NUL-separates *every* field, including the status from the path
 * (`A\0path\0`, `R100\0old\0new\0`) — reading it as tab-separated silently
 * matched nothing, which is why a turn's patch came back empty.
 */
export function parseNameStatusZ(output: string): Array<{ path: string; oldPath?: string; status: ChangeStatus }> {
  const fields = output.split("\0").filter((field) => field !== "");
  const changes: Array<{ path: string; oldPath?: string; status: ChangeStatus }> = [];

  for (let index = 0; index < fields.length; index += 1) {
    const code = (fields[index] ?? "").charAt(0);
    if (!code) continue;

    if (code === "R" || code === "C") {
      const oldPath = fields[index + 1] ?? "";
      const path = fields[index + 2] ?? "";
      index += 2;
      if (path) changes.push({ path, ...(oldPath ? { oldPath } : {}), status: "renamed" });
      continue;
    }

    const path = fields[index + 1] ?? "";
    index += 1;
    if (!path) continue;
    changes.push({
      path,
      status: code === "A" ? "added" : code === "D" ? "deleted" : "modified",
    });
  }

  return changes;
}

/** `git diff --numstat -z` → additions/deletions per path (`-` means binary). */
export function parseNumStatZ(output: string): Map<string, { additions: number; deletions: number; binary: boolean }> {
  const result = new Map<string, { additions: number; deletions: number; binary: boolean }>();
  const entries = output.split("\0").filter(Boolean);

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) continue;
    const [additionsField, deletionsField, ...pathFields] = entry.split("\t");
    if (additionsField === undefined || deletionsField === undefined) continue;
    let filePath = pathFields.join("\t");
    // Renames arrive as `<path>\0<oldPath>` in the following entry.
    if (filePath === "") {
      filePath = entries[index + 1] ?? "";
      index += 1;
    }
    if (!filePath) continue;
    const binary = additionsField === "-" || deletionsField === "-";
    result.set(filePath, {
      binary,
      additions: binary ? 0 : Number.parseInt(additionsField, 10) || 0,
      deletions: binary ? 0 : Number.parseInt(deletionsField, 10) || 0,
    });
  }

  return result;
}

/** `git diff --unified=N` → hunks per path, in diff order. */
export function parseUnifiedDiff(output: string): Map<string, DiffHunk[]> {
  const hunksByPath = new Map<string, DiffHunk[]>();
  let currentPath: string | null = null;
  let oldPath: string | null = null;
  let current: DiffHunk | null = null;
  let hunkOldLine = 0;
  let hunkNewLine = 0;

  const flush = () => {
    if (currentPath && current) {
      const existing = hunksByPath.get(currentPath) ?? [];
      existing.push(current);
      hunksByPath.set(currentPath, existing);
    }
    current = null;
  };

  for (const line of output.split("\n")) {
    if (line.startsWith("diff --git ")) {
      // Section boundary: the header itself is not hunk content.
      flush();
      continue;
    }
    if (line.startsWith("--- ")) {
      // A new file section closes the previous file's last hunk — otherwise it
      // would be attributed to the *next* path.
      flush();
      // Kept so a deletion (`+++ /dev/null`) still resolves to its own path.
      const target = line.slice(4).trim();
      oldPath = target === "/dev/null" ? null : target.replace(/^a\//, "");
      continue;
    }
    if (line.startsWith("+++ ")) {
      const target = line.slice(4).trim();
      currentPath = target === "/dev/null" ? oldPath ?? currentPath : target.replace(/^b\//, "");
      continue;
    }
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header) {
      flush();
      hunkOldLine = Number.parseInt(header[1] ?? "0", 10);
      hunkNewLine = Number.parseInt(header[3] ?? "0", 10);
      current = {
        header: line,
        oldStart: hunkOldLine,
        oldLines: Number.parseInt(header[2] ?? "1", 10),
        newStart: hunkNewLine,
        newLines: Number.parseInt(header[4] ?? "1", 10),
        lines: [],
      };
      continue;
    }
    // Every unified-diff body line carries a prefix (' ', '+' or '-'), so a
    // blank line is only ever the trailing artifact of the final newline.
    if (!current || line === "") continue;
    const marker = line.charAt(0);
    if (marker === "\\") continue; // "\ No newline at end of file"
    const text = line.slice(1);
    if (marker === "+") {
      current.lines.push({ type: "add", newLine: hunkNewLine, text });
      hunkNewLine += 1;
    } else if (marker === "-") {
      current.lines.push({ type: "delete", oldLine: hunkOldLine, text });
      hunkOldLine += 1;
    } else {
      current.lines.push({ type: "context", oldLine: hunkOldLine, newLine: hunkNewLine, text });
      hunkOldLine += 1;
      hunkNewLine += 1;
    }
  }
  flush();

  return hunksByPath;
}

/**
 * Read the working tree's changes. `includeHunks` costs one extra `git diff`
 * and is worth it only for a pane that actually renders the diff.
 */
export async function readWorkspaceChanges(
  run: GitRun,
  options: { includeHunks?: boolean; scope?: ChangeScope } = {},
): Promise<WorkspaceChangeSnapshot> {
  const revision = await run(["rev-parse", "--short", "HEAD"]).then(
    (result) => (result.code === 0 ? result.stdout.trim() || null : null),
  );

  const staged = options.scope === "staged";
  // Unstaged covers the whole working tree (including untracked files); staged is
  // the index, which is what a commit would record.
  const entries = staged
    ? parseNameStatusZ((await run(["diff", "--cached", "--name-status", "-z"])).stdout)
    : parsePorcelainV2((await run(["status", "--porcelain=v2", "-z", "--untracked-files=all"])).stdout);
  if (entries.length === 0) return { revision, files: [] };

  const diffPrefix = staged ? ["diff", "--cached"] : ["diff"];
  const numstat = parseNumStatZ((await run([...diffPrefix, "--numstat", "-z"])).stdout);
  const hunks = options.includeHunks
    ? parseUnifiedDiff((await run([...diffPrefix, "--unified=3", "--no-color"])).stdout)
    : null;

  const files: WorkspaceFileChange[] = [];
  for (const entry of entries) {
    const stats = numstat.get(entry.path);
    const fileHunks = hunks?.get(entry.path);
    files.push({
      path: entry.path,
      ...(entry.oldPath ? { oldPath: entry.oldPath } : {}),
      status: stats?.binary ? "binary" : entry.status,
      additions: stats?.additions ?? 0,
      deletions: stats?.deletions ?? 0,
      ...(fileHunks?.length ? { hunks: fileHunks } : {}),
    });
  }

  return { revision, files };
}

/**
 * A tree hash of the *content* visible right now: tracked modifications, what is
 * staged, and untracked (non-ignored) files, without touching the user's index.
 *
 * This is the only baseline that can attribute a turn correctly. A revision (or
 * `git diff` on the working tree) misses exactly the cases that matter: text the
 * user had already staged, files they had not added yet, and any work the turn
 * itself commits — after which the working tree is clean and `git diff` says
 * nothing changed.
 */
export async function snapshotWorkspaceTree(
  run: GitRun,
): Promise<{ tree: string; head: string | null }> {
  const directory = await mkdtemp(path.join(tmpdir(), "sofia-baseline-index-"));
  // A throwaway index: `git add -A` here never stages anything for the user.
  const env = { GIT_INDEX_FILE: path.join(directory, "index") };
  try {
    const head = await run(["rev-parse", "--verify", "--quiet", "HEAD"]);
    const hasHead = head.code === 0 && head.stdout.trim().length > 0;
    if (hasHead) await run(["read-tree", "HEAD"], env);
    await run(["add", "-A"], env);
    const written = await run(["write-tree"], env);
    return { tree: written.stdout.trim(), head: hasHead ? head.stdout.trim() : null };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * The turn's content delta: `baselineTree → endTree`. Because the baseline tree
 * already contains whatever the user had staged, unstaged or untracked, only what
 * happened *during* the turn appears here — whether the turn edited, staged,
 * committed once, committed five times, or reformatted the repository.
 */
export async function readTurnDelta(
  run: GitRun,
  input: { baselineTree: string; endTree: string; includeHunks?: boolean },
): Promise<WorkspaceChangeSnapshot> {
  const baselineTree = input.baselineTree.trim();
  const endTree = input.endTree.trim();
  if (!baselineTree || !endTree) return { revision: endTree || null, files: [] };

  const range = `${baselineTree}..${endTree}`;
  const statuses = parseNameStatusZ((await run(["diff", "--name-status", "-z", "--find-renames", range])).stdout);
  if (statuses.length === 0) return { revision: endTree, files: [] };

  const numstat = parseNumStatZ((await run(["diff", "--numstat", "-z", "--find-renames", range])).stdout);
  const hunks = input.includeHunks
    ? parseUnifiedDiff((await run(["diff", "--unified=3", "--no-color", "--find-renames", range])).stdout)
    : null;

  const files: WorkspaceFileChange[] = statuses.map((entry) => {
    const stats = numstat.get(entry.path);
    const fileHunks = hunks?.get(entry.path);
    return {
      path: entry.path,
      ...(entry.oldPath ? { oldPath: entry.oldPath } : {}),
      status: stats?.binary ? "binary" : entry.status,
      additions: stats?.additions ?? 0,
      deletions: stats?.deletions ?? 0,
      ...(fileHunks?.length ? { hunks: fileHunks } : {}),
    };
  });

  return { revision: endTree, files };
}

/**
 * Untracked files never appear in `git diff`, so `readWorkspaceChanges` reports
 * zero lines for them. A repo-backed producer fills that gap from the bytes.
 */
export async function countUntrackedLines(root: string, files: WorkspaceFileChange[]): Promise<WorkspaceFileChange[]> {
  return Promise.all(
    files.map(async (file) => {
      if (file.status !== "added" || file.additions > 0) return file;
      try {
        const target = path.join(root, file.path);
        const info = await stat(target);
        // Guard rail: never try to line-count something large or binary.
        if (!info.isFile() || info.size > 512 * 1024) return file;
        const contents = await readFile(target, "utf8");
        if (contents.includes("\0")) return { ...file, status: "binary" as ChangeStatus };
        const lines = contents.length === 0 ? 0 : contents.split("\n").length - (contents.endsWith("\n") ? 1 : 0);
        return { ...file, additions: lines };
      } catch {
        return file;
      }
    }),
  );
}

/** Run git in a directory, never throwing on a non-zero exit. */
export function createGitRun(root: string, timeoutMs = 15_000): GitRun {
  return (args, env) =>
    new Promise<GitResult>((resolve) => {
      execFile("git", ["-C", root, ...args], { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, env: env ? { ...process.env, ...env } : undefined }, (error, stdout) => {
        const code = error && typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : error ? 1 : 0;
        resolve({ stdout: stdout ?? "", code });
      });
    });
}
