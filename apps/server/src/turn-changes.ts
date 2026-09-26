/**
 * Turn-owned change tracking.
 *
 * The invariant: **every completed turn owns zero or one immutable ChangeSet,
 * and that association is persisted with the turn itself.**
 *
 *   turn begins  → snapshot the workspace  → turnRecord.baselineTree
 *   turn runs    → anything may write files
 *   turn ends    → snapshot again → freeze the delta → turnRecord.changeSetId
 *
 * Owning this on the server rather than in the renderer removes two fragile
 * things at once: capture/finalize no longer depends on a mounted surface, and
 * the turn↔ChangeSet association is no longer "the newest one this session saw".
 *
 * Nothing here may block or fail a turn. If git is unavailable, or there is no
 * repository, the turn still runs and the record simply has no ChangeSet — the
 * UI can then honestly present a hint-only card.
 */
import {
  readTurnDelta,
  snapshotWorkspaceTree,
  type GitRun,
  type WorkspaceFileChange,
} from "./git-changes.js";

/** Persisted with the turn, so a historical card stays deterministic. */
export type TurnChangeRecord = {
  turnId: string;
  /** When the logical turn started and (once it is over) completed. */
  startedAt: number;
  completedAt?: number;
  baselineTree?: string;
  endTree?: string;
  headBefore?: string | null;
  headAfter?: string | null;
  /** Zero or one ChangeSet per completed turn. */
  changeSetId?: string;
  files: WorkspaceFileChange[];
  additions: number;
  deletions: number;
  patch?: string;
  commitsInRange?: string[];
  /** Why there is no ChangeSet, when there is none. */
  unavailable?: string;
};

export function turnChangeSetId(sessionId: string, turnId: string): string {
  return `turn:${sessionId}:${turnId}`;
}

type OpenTurn = {
  turnId: string;
  startedAt: number;
  baselineTree?: string;
  headBefore?: string | null;
  baselineError?: string;
};

export type TurnChangesOptions = {
  sessionId: string;
  /** Resolve a git runner for a directory, or null when there is none. */
  gitFor: (sessionId: string) => GitRun | null;
  /** Where the records live (a session map, a store, anything). */
  records: Map<string, TurnChangeRecord>;
  now?: () => number;
  log?: (line: string) => void;
};

/**
 * One tracker per session. `beginTurn` is called once per *logical* turn — a new
 * user prompt — and `finalizeTurn` on completion. A continuation that the engine
 * starts on its own does not call `beginTurn`, so the logical turn keeps its
 * original baseline and its single ChangeSet covers the whole thing.
 */
export class TurnChangeTracker {
  private readonly open = new Map<string, OpenTurn>();

  constructor(private readonly options: TurnChangesOptions) {}

  /** A new logical turn began. Never throws, never blocks the turn. */
  async beginTurn(turnId: string): Promise<void> {
    const now = this.options.now?.() ?? Date.now();
    this.options.log?.(`[changes] turn-start session=${this.options.sessionId} turn=${turnId}`);
    const existing = this.open.get(this.options.sessionId);
    if (existing && existing.turnId === turnId) return;

    const open: OpenTurn = { turnId, startedAt: now };
    this.open.set(this.options.sessionId, open);

    const run = this.options.gitFor(this.options.sessionId);
    if (!run) {
      open.baselineError = "no repository access";
      return;
    }
    try {
      const snapshot = await snapshotWorkspaceTree(run);
      open.baselineTree = snapshot.tree;
      open.headBefore = snapshot.head;
      this.options.log?.(
        `[changes] baseline captured session=${this.options.sessionId} turn=${turnId} tree=${snapshot.tree || "none"}`,
      );
    } catch (error) {
      open.baselineError = error instanceof Error ? error.message : "baseline failed";
    }
  }

  /**
   * The turn completed. Freezes the delta if a baseline exists; otherwise records
   * why not. Always leaves a record, so the UI never has to guess.
   */
  async finalizeTurn(turnId: string): Promise<TurnChangeRecord> {
    const now = this.options.now?.() ?? Date.now();
    this.options.log?.(`[changes] turn-complete session=${this.options.sessionId} turn=${turnId}`);
    const open = this.open.get(this.options.sessionId);
    const record = this.recordFor(turnId, open);
    record.completedAt = now;

    const run = this.options.gitFor(this.options.sessionId);
    if (!run) {
      record.unavailable = open?.baselineError ?? "no repository access";
      this.options.records.set(turnId, record);
      return record;
    }

    if (!open?.baselineTree) {
      // Explicit degradation: no baseline means no counts, never invented ones.
      record.unavailable = open?.baselineError ?? "no baseline was captured for this turn";
      this.options.records.set(turnId, record);
      this.options.log?.(
        `[changes] finalized turn=${turnId} changeSet=none source=unavailable reason=${record.unavailable}`,
      );
      return record;
    }

    try {
      const end = await snapshotWorkspaceTree(run);
      record.baselineTree = open.baselineTree;
      record.endTree = end.tree;
      record.headBefore = open.headBefore ?? null;
      record.headAfter = end.head;

      if (end.tree && end.tree !== open.baselineTree) {
        const delta = await readTurnDelta(run, {
          baselineTree: open.baselineTree,
          endTree: end.tree,
          includeHunks: true,
          includePatch: true,
        });
        record.files = delta.files;
        record.additions = delta.files.reduce((total, file) => total + file.additions, 0);
        record.deletions = delta.files.reduce((total, file) => total + file.deletions, 0);
        if (delta.patch !== undefined) record.patch = delta.patch;
        record.commitsInRange =
          open.headBefore && end.head && open.headBefore !== end.head
            ? await this.commitsBetween(run, open.headBefore, end.head)
            : [];
      }

      record.changeSetId = turnChangeSetId(this.options.sessionId, turnId);
      this.options.records.set(turnId, record);
      this.options.log?.(
        `[changes] finalized turn=${turnId} changeSet=${record.changeSetId} files=${record.files.length} +${record.additions} -${record.deletions} source=tree-delta`,
      );
      return record;
    } catch (error) {
      record.unavailable = error instanceof Error ? error.message : "finalize failed";
      this.options.records.set(turnId, record);
      this.options.log?.(
        `[changes] finalized turn=${turnId} changeSet=none source=unavailable reason=${record.unavailable}`,
      );
      return record;
    }
  }

  getRecord(turnId: string): TurnChangeRecord | null {
    return this.options.records.get(turnId) ?? null;
  }

  private recordFor(turnId: string, open: OpenTurn | undefined): TurnChangeRecord {
    const existing = this.options.records.get(turnId);
    if (existing) return existing;
    return {
      turnId,
      startedAt: open?.startedAt ?? this.options.now?.() ?? Date.now(),
      files: [],
      additions: 0,
      deletions: 0,
    };
  }

  private async commitsBetween(run: GitRun, before: string, after: string): Promise<string[]> {
    const result = await run(["rev-list", "--no-merges", `${before}..${after}`]);
    if (result.code !== 0) return [];
    return result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  }
}
