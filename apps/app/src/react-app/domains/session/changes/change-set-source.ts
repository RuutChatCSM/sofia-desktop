import {
  beginTurnChangeSet,
  reconcileTurnChangeSet,
  type FileChange,
  type TurnChangeSet,
} from "./turn-change-set";

/** One file as the repository reports it (before turn attribution is applied). */
export type WorkspaceChangeFile = Omit<FileChange, "attributedToTurn">;

export type WorkspaceChangesResponse = {
  revision: string | null;
  files: WorkspaceChangeFile[];
  /** Present when the read was a content snapshot (?snapshot=1). */
  tree?: string;
  head?: string | null;
  /** Present when a tree delta was read with ?patch=1. */
  patch?: string;
  /** Commits the turn created, when the request carried both heads. */
  commits?: string[];
};

export type WorkspaceSnapshot = {
  tree: string;
  head: string | null;
};

/**
 * Repository state captured when a turn starts.
 *
 * Without it, "the turn changed this file" is indistinguishable from "this file
 * was already dirty", and Undo would have to revert whole files — destroying
 * work the user had in flight before Sofia ever started.
 */
export type TurnBaseline = {
  revision: string | null;
  /** Paths already dirty at turn start, with the counts they had then. */
  dirty: Map<string, { additions: number; deletions: number }>;
  /** Content snapshot at turn start — the authoritative baseline when present. */
  snapshot: WorkspaceSnapshot | null;
};

export function baselineFromChanges(
  response: WorkspaceChangesResponse,
  snapshot: WorkspaceSnapshot | null = null,
): TurnBaseline {
  const dirty = new Map<string, { additions: number; deletions: number }>();
  for (const file of response.files) {
    dirty.set(file.path, { additions: file.additions, deletions: file.deletions });
  }
  return { revision: response.revision, dirty, snapshot };
}

/**
 * Attribute a repository observation to a turn.
 *
 * A file the turn did not write keeps `attributedToTurn: false`, so it is shown
 * ("Not from Sofia") but is never part of Undo. The comparison is by reported
 * counts, which is deliberately cheap; two different edits that happen to have
 * the same counts would be mis-attributed, and content hashes are the fix if
 * that ever matters.
 */
export function attributeFilesToTurn(input: {
  baseline: TurnBaseline | null;
  files: readonly WorkspaceChangeFile[];
}): FileChange[] {
  return input.files.map((file) => {
    const before = input.baseline?.dirty.get(file.path);
    const untouched =
      before !== undefined && before.additions === file.additions && before.deletions === file.deletions;
    return { ...file, attributedToTurn: !untouched };
  });
}

/** Build the durable set for a finished turn from a repository observation. */
export function changeSetFromRepository(input: {
  sessionId: string;
  turnId: string;
  startedAt: number;
  baseline: TurnBaseline | null;
  snapshot: WorkspaceChangesResponse;
  repositoryId?: string;
  root?: string;
  finalizedAt: number;
  patch?: string;
  commitsInRange?: string[];
  /** Content snapshots the delta was taken between, when the read used them. */
  trees?: {
    baselineTree: string;
    endTree: string;
    headBefore: string | null;
    headAfter: string | null;
  };
}): TurnChangeSet {
  const started = beginTurnChangeSet({
    sessionId: input.sessionId,
    turnId: input.turnId,
    startedAt: input.startedAt,
  });

  const reconciled = reconcileTurnChangeSet(started, {
    source: "git",
    repositories: [
      {
        repositoryId: input.repositoryId ?? "workspace",
        root: input.root ?? "",
        ...(input.snapshot.revision ? { baseRevision: input.snapshot.revision } : {}),
        ...(input.trees
          ? {
              baselineTree: input.trees.baselineTree,
              endTree: input.trees.endTree,
              headBefore: input.trees.headBefore,
              headAfter: input.trees.headAfter,
            }
          : {}),
        ...(input.patch ? { patch: input.patch } : {}),
        ...(input.commitsInRange && input.commitsInRange.length > 0
          ? { commitsInRange: input.commitsInRange }
          : {}),
        // A tree delta already excludes everything the user had in flight before
        // the turn began (it is in the baseline tree), so every file in it is the
        // turn's own change. The count-based check stays for the fallback path,
        // where the only baseline available is "which paths were dirty".
        files: input.trees
          ? input.snapshot.files.map((file) => ({ ...file, attributedToTurn: true }))
          : attributeFilesToTurn({ baseline: input.baseline, files: input.snapshot.files }),
      },
    ],
  });

  // A repository observation is a settled fact: the turn is over, so the set is
  // frozen and can never be rewritten by a later observation.
  return { ...reconciled, finalizedAt: input.finalizedAt };
}
