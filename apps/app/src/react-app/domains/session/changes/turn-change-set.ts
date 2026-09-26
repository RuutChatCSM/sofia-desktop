/**
 * What a turn *changed* — a durable, reviewable object with its own lifecycle.
 *
 * Deliberately separate from the other two surfaces:
 *
 *   TurnWorkBlock  how Sofia worked        "Worked for 4m 12s"
 *   TurnChangeSet  what Sofia changed      "Edited 6 files · +182 −47"
 *   Activity       what Sofia is doing now "Running the tests"
 *
 * A ChangeSet outlives the turn it describes: the work block collapses, the
 * activity ends, and the result is still reviewable ten minutes later.
 *
 * Two rules this module exists to enforce:
 *
 * 1. **Identity is immutable.** A card renders a `changeSetId`; it never means
 *    "run git diff right now". A historical turn must never show the newest
 *    working-tree diff under yesterday's summary.
 * 2. **The change set is not the tool log.** `apply_patch` events (and every
 *    other hint source) are labelled as such: only a repository-level source
 *    (`source: "git"`) is authoritative, because a shell command, a formatter,
 *    a script or an MCP tool can edit files without any edit event.
 */
export type ChangeStatus = "added" | "modified" | "deleted" | "renamed" | "binary";

/**
 * A structured diff line, carrying its own line numbers on both sides so the
 * viewer can render gutters, colour additions and deletions, and anchor inline
 * comments — rather than re-parsing formatted git text.
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

export type FileChange = {
  path: string;
  status: ChangeStatus;
  /** Previous path, for renames. */
  oldPath?: string;
  additions: number;
  deletions: number;
  hunks?: DiffHunk[];
  /**
   * False when the file was already dirty before the turn started. Undo must
   * invert only the turn's own patch — reverting a file wholesale would destroy
   * work the user had in flight.
   */
  attributedToTurn: boolean;
};

export type RepositoryChangeSet = {
  repositoryId: string;
  root: string;
  /** Revision the turn started from, when a repository source could resolve one. */
  baseRevision?: string;
  /**
   * The content snapshots the patch is the diff of. Recorded so the change set
   * describes the *turn* rather than the repository's current state: a turn that
   * commits, or one that begins with work already staged and untracked, is still
   * exactly representable.
   */
  baselineTree?: string;
  endTree?: string;
  headBefore?: string | null;
  headAfter?: string | null;
  /**
   * The patch itself, frozen with the set. Replaying or reversing a historical
   * turn must never re-derive it from the repository, which may have moved on.
   */
  patch?: string;
  /** Commits this turn created — a related fact, not the identity of the set. */
  commitsCreated?: string[];
  files: FileChange[];
};

/**
 * `"git"` is authoritative (repository state, whoever wrote the bytes).
 * `"tool-events"` is a hint stream and must never be presented as the truth.
 */
export type ChangeSetSource = "git" | "tool-events";

export type TurnChangeSet = {
  id: string;
  sessionId: string;
  turnId: string;
  source: ChangeSetSource;
  repositories: RepositoryChangeSet[];
  startedAt: number;
  finalizedAt?: number;
};

/** The immutable handle a card (and a Review pane) addresses. */
export function turnChangeSetId(sessionId: string, turnId: string): string {
  return `turn:${sessionId}:${turnId}`;
}

export function beginTurnChangeSet(input: {
  sessionId: string;
  turnId: string;
  startedAt: number;
  source?: ChangeSetSource;
}): TurnChangeSet {
  return {
    id: turnChangeSetId(input.sessionId, input.turnId),
    sessionId: input.sessionId,
    turnId: input.turnId,
    source: input.source ?? "tool-events",
    repositories: [],
    startedAt: input.startedAt,
  };
}

export function isFrozen(changeSet: TurnChangeSet): boolean {
  return typeof changeSet.finalizedAt === "number";
}

const SOURCE_RANK: Record<ChangeSetSource, number> = { "tool-events": 0, git: 1 };

/**
 * Fold a fresh observation in. Refuses to touch a finalized set — that is the
 * invariant behind "a historical card never shows the current working tree" —
 * and never downgrades to a weaker source.
 */
export function reconcileTurnChangeSet(
  changeSet: TurnChangeSet,
  observation: {
    repositories: RepositoryChangeSet[];
    source: ChangeSetSource;
    at?: number;
  },
): TurnChangeSet {
  if (isFrozen(changeSet)) return changeSet;
  if (SOURCE_RANK[observation.source] < SOURCE_RANK[changeSet.source]) return changeSet;
  return {
    ...changeSet,
    source: observation.source,
    repositories: observation.repositories,
    finalizedAt: observation.at === undefined ? changeSet.finalizedAt : observation.at,
  };
}

/** Freeze the set: its patch is settled and no later observation may rewrite it. */
export function finalizeTurnChangeSet(changeSet: TurnChangeSet, at: number): TurnChangeSet {
  if (isFrozen(changeSet)) return changeSet;
  return { ...changeSet, finalizedAt: at };
}

export function changeSetFiles(changeSet: TurnChangeSet): FileChange[] {
  return changeSet.repositories.flatMap((repository) => repository.files);
}

/** Files this turn is responsible for — the only ones Undo may invert. */
export function attributedFiles(changeSet: TurnChangeSet): FileChange[] {
  return changeSetFiles(changeSet).filter((file) => file.attributedToTurn);
}

/**
 * Working-tree changes the turn did *not* make. Surfaced separately so "what
 * did Sofia do?" never gets confused with "what is currently dirty?".
 */
export function unattributedFiles(changeSet: TurnChangeSet): FileChange[] {
  return changeSetFiles(changeSet).filter((file) => !file.attributedToTurn);
}

export type ChangeSetTotals = {
  files: number;
  additions: number;
  deletions: number;
  /** False when the source cannot count lines (a hint stream, or binaries only). */
  countsKnown: boolean;
};

export function changeSetTotals(changeSet: TurnChangeSet): ChangeSetTotals {
  const files = changeSetFiles(changeSet);
  return {
    files: files.length,
    additions: files.reduce((total, file) => total + file.additions, 0),
    deletions: files.reduce((total, file) => total + file.deletions, 0),
    countsKnown: changeSet.source === "git",
  };
}

/** The one-line result the transcript shows, e.g. "Edited 6 files" / "Edited a.ts". */
export function changeSetTitle(changeSet: TurnChangeSet): string {
  const files = changeSetFiles(changeSet);
  if (files.length === 0) return "No file changes";
  if (files.length === 1) {
    const file = files[0];
    const name = file?.path.split("/").pop() ?? file?.path ?? "";
    if (file?.status === "renamed") return `Renamed ${name}`;
    if (file?.status === "added") return `Added ${name}`;
    if (file?.status === "deleted") return `Deleted ${name}`;
    if (file?.status === "binary") return `Updated ${name}`;
    return `Edited ${name}`;
  }
  const anyEdit = files.some((file) => file.status === "modified" || file.status === "renamed" || file.status === "binary");
  return `${anyEdit ? "Edited" : "Added"} ${files.length} files`;
}

/** Per-file row label, status-aware — never "Edited hero.png" for a binary. */
export function fileChangeLabel(file: FileChange): string {
  const name = file.path.split("/").pop() ?? file.path;
  if (file.status === "renamed") {
    return `Renamed ${file.oldPath?.split("/").pop() ?? file.oldPath} → ${name}`;
  }
  if (file.status === "binary") return `${name}`;
  return name;
}

export function fileChangeNote(file: FileChange): string | null {
  if (file.status === "binary") return "Binary file";
  return null;
}

/** Undo is only meaningful for a turn that is over and has attributed changes. */
export function canUndoChangeSet(changeSet: TurnChangeSet): boolean {
  return isFrozen(changeSet) && attributedFiles(changeSet).length > 0;
}

/**
 * `git diff --numstat` → file changes.
 *
 * This is the shape the authoritative source produces; parsing it here keeps the
 * "repository state, not tool events" contract testable before a git-backed
 * producer is wired in. Binary files report `-` for both counts, and renames
 * arrive as `old => new` or `dir/{old => new}.ts`.
 */
export function parseNumStat(output: string): FileChange[] {
  const files: FileChange[] = [];
  for (const rawLine of output.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line) continue;
    const [additionsField, deletionsField, ...pathFields] = line.split("\t");
    const pathField = pathFields.join("\t");
    if (additionsField === undefined || deletionsField === undefined || !pathField) continue;

    const binary = additionsField === "-" || deletionsField === "-";
    const renamed = pathField.includes(" => ");
    const { path, oldPath } = splitRename(pathField);
    files.push({
      path,
      status: binary ? "binary" : renamed ? "renamed" : "modified",
      ...(oldPath ? { oldPath } : {}),
      additions: binary ? 0 : Number.parseInt(additionsField, 10) || 0,
      deletions: binary ? 0 : Number.parseInt(deletionsField, 10) || 0,
      attributedToTurn: true,
    });
  }
  return files;
}

/** `dir/{a => b}.ts` → `dir/b.ts`, and `old.ts => new.ts` → `new.ts`. */
function splitRename(pathField: string): { path: string; oldPath?: string } {
  const braces = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(pathField);
  if (braces) {
    const [, prefix = "", oldPart = "", newPart = "", suffix = ""] = braces;
    return { path: `${prefix}${newPart}${suffix}`, oldPath: `${prefix}${oldPart}${suffix}` };
  }
  const [oldPath, newPath] = pathField.split(" => ");
  if (oldPath && newPath) return { path: newPath, oldPath };
  return { path: pathField };
}
