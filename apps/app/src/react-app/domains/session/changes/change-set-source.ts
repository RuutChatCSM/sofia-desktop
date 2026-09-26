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
  /**
   * Per-repository files. A workspace may be a directory of checkouts, in which
   * case this is the only shape that can describe it.
   */
  repositories?: Array<{
    repositoryId: string;
    root: string;
    /** Present on a delta read; absent on a snapshot read, which has `tree`. */
    revision?: string | null;
    files?: WorkspaceChangeFile[];
    /** Present on a snapshot read. */
    tree?: string;
    head?: string | null;
    /** The content snapshots a delta read was taken between. */
    baselineTree?: string;
    endTree?: string;
    headBefore?: string | null;
    headAfter?: string | null;
    /** Replay-grade patch for this repository, frozen with its files. */
    patch?: string;
    /** Commits that appeared in this repository between the two heads. */
    commitsInRange?: string[];
    /** Set instead of files when a repository could not be reconciled. */
    unavailable?: string;
    appearedDuringTurn?: boolean;
  }>;
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
  /** Per-repository files, when the read covered more than one checkout. */
  repositories?: NonNullable<WorkspaceChangesResponse["repositories"]>;
  /**
   * True when this read is the repository's *current* dirtiness rather than the
   * turn's own delta. Nothing in it may be presented as Sofia's work, so every
   * file is marked unattributed — mislabelling yesterday's edits as this turn's
   * is worse than showing nothing.
   */
  attributionUnavailable?: boolean;
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

  const repositoryReads = input.repositories ?? input.snapshot.repositories ?? [];
  // A top-level patch/commits can only belong to a set that covers one repository;
  // with several, splitting the aggregate would attribute one checkout's diff to
  // another. The server reports them per repository for the multi-checkout case.
  const soleRepository = repositoryReads.length === 1;
  const reconciled = reconcileTurnChangeSet(started, {
    source: "git",
    repositories: repositoryReads.length
      ? repositoryReads.map((repository) => {
          // The server reports the patch per repository; a top-level patch is the
          // single-repository response shape and only safe to use when there is
          // exactly one checkout to attach it to.
          const patch = repository.patch ?? (soleRepository ? input.patch ?? input.snapshot.patch : undefined);
          const commitsInRange =
            repository.commitsInRange ??
            (soleRepository ? input.commitsInRange ?? input.snapshot.commits : undefined);
          return {
            repositoryId: repository.repositoryId,
            root: repository.root,
            ...(repository.revision ? { baseRevision: repository.revision } : {}),
            ...(repository.baselineTree ? { baselineTree: repository.baselineTree } : {}),
            ...(repository.endTree ? { endTree: repository.endTree } : {}),
            ...(repository.headBefore === undefined ? {} : { headBefore: repository.headBefore }),
            ...(repository.headAfter === undefined ? {} : { headAfter: repository.headAfter }),
            ...(patch ? { patch } : {}),
            ...(commitsInRange && commitsInRange.length > 0 ? { commitsInRange } : {}),
            // A per-repository read reports what each checkout has now; nothing
            // here is another repository's file, which is the point of the shape.
            files: (repository.files ?? []).map((file) => ({
              ...file,
              attributedToTurn: !input.attributionUnavailable,
            })),
          };
        })
      : [
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
        files: input.attributionUnavailable
          ? input.snapshot.files.map((file) => ({ ...file, attributedToTurn: false }))
          : input.trees
            ? input.snapshot.files.map((file) => ({ ...file, attributedToTurn: true }))
            : attributeFilesToTurn({ baseline: input.baseline, files: input.snapshot.files }),
      },
    ],
  });

  // A repository observation is a settled fact: the turn is over, so the set is
  // frozen and can never be rewritten by a later observation.
  return {
    ...reconciled,
    finalizedAt: input.finalizedAt,
    // Without a baseline the read is the repository's current state. It is kept
    // (the touched files are still useful) but marked so the UI never prints it
    // as the turn's own `+A −D`.
    ...(input.attributionUnavailable ? { attributed: false } : {}),
  };
}
