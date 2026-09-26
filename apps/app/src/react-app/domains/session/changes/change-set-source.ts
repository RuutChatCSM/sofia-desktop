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
};

export function baselineFromChanges(response: WorkspaceChangesResponse): TurnBaseline {
  const dirty = new Map<string, { additions: number; deletions: number }>();
  for (const file of response.files) {
    dirty.set(file.path, { additions: file.additions, deletions: file.deletions });
  }
  return { revision: response.revision, dirty };
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
        files: attributeFilesToTurn({ baseline: input.baseline, files: input.snapshot.files }),
      },
    ],
  });

  // A repository observation is a settled fact: the turn is over, so the set is
  // frozen and can never be rewritten by a later observation.
  return { ...reconciled, finalizedAt: input.finalizedAt };
}
