import { changeSetFromRepository, type WorkspaceChangesResponse } from "./change-set-source";
import { useChangeSetStore } from "./change-set-store";

/** The read parameters, shared by both client shapes. */
export type RepositoryBaseline = { repositoryId: string; root: string; tree: string; head: string | null };

export type WorkspaceChangeParams = {
  hunks?: boolean;
  patch?: boolean;
  snapshot?: boolean;
  baselineTree?: string;
  endTree?: string;
  headBefore?: string | null;
  headAfter?: string | null;
  /** Per-repository baselines, for a workspace that covers several checkouts. */
  baselines?: RepositoryBaseline[];
};

/**
 * Either client works: the workspace-scoped one (`git.changes`) is preferred
 * because it does not care which engine drives a session, and the codex
 * session-scoped one (`workspaceChanges`) is the fallback for a session whose
 * engine client is not bound. Injected rather than imported, so it is testable.
 */
export type WorkspaceChangesClient = {
  git?: {
    changes?: (params: { workspaceId: string } & WorkspaceChangeParams) => Promise<WorkspaceChangesResponse>;
  };
  workspaceChanges?: (sessionId: string, params?: WorkspaceChangeParams) => Promise<WorkspaceChangesResponse>;
};

/** Whichever read this client can perform. Throws rather than pretending. */
async function readChanges(
  client: WorkspaceChangesClient,
  input: { workspaceId: string; sessionId: string; params: WorkspaceChangeParams },
): Promise<WorkspaceChangesResponse> {
  const workspaceScoped = client.git?.changes;
  if (typeof workspaceScoped === "function") {
    return workspaceScoped({ workspaceId: input.workspaceId, ...input.params });
  }
  const sessionScoped = client.workspaceChanges;
  if (typeof sessionScoped === "function") {
    return sessionScoped(input.sessionId, input.params);
  }
  throw new Error("no change client is bound to this session");
}

/**
 * Repository baselines, keyed by session, held while a turn is open. A
 * server-side continuation keeps its turn open, so the baseline is not
 * re-captured mid-turn.
 */
type SessionBaseline = {
  turnId: string;
  startedAt: number;
  closed: boolean;
  /** Per repository, matched by canonical root rather than array position. */
  repositories: RepositoryBaseline[];
  unavailable?: string;
};

const turnBaselines = new Map<string, SessionBaseline>();

/**
 * The in-flight baseline read per session. Capture is fire-and-forget at turn
 * start, so a turn that ends quickly — or a snapshot of several checkouts that
 * takes a moment — could otherwise reach finalize before its own baseline
 * exists and be recorded as unattributed for the rest of its life.
 */
const turnBaselineReads = new Map<string, Promise<void>>();

export function resetTurnBaselines(): void {
  turnBaselines.clear();
  turnBaselineReads.clear();
}

/**
 * Snapshot the repository the turn starts from. Best-effort: with no baseline a
 * turn can only be described by the files its tools touched, which is why the
 * capture failing silently leaves a card without counts rather than a wrong one.
 */
export async function captureTurnBaseline(input: {
  client: WorkspaceChangesClient | null;
  workspaceId: string;
  sessionId: string;
  turnId: string;
}): Promise<void> {
  const existing = turnBaselines.get(input.sessionId);
  if (existing && !existing.closed) return;
  const pending = turnBaselineReads.get(input.sessionId);
  if (pending) return pending;

  const read = readTurnBaseline(input);
  turnBaselineReads.set(input.sessionId, read);
  try {
    await read;
  } finally {
    turnBaselineReads.delete(input.sessionId);
  }
}

async function readTurnBaseline(input: {
  client: WorkspaceChangesClient | null;
  workspaceId: string;
  sessionId: string;
  turnId: string;
}): Promise<void> {
  const client = input.client;
  if (!client) {
    // Never silent: this is the case that used to leave no trace at all, which
    // made "the pipeline did not run" indistinguishable from "it ran and found
    // nothing".
    console.warn(
      `[changes] no client bound for session=${input.sessionId} turn=${input.turnId} — change tracking is off for this turn`,
    );
    return;
  }
  try {
    const snapshot = await readChanges(client, {
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      params: { snapshot: true },
    });
    // Only repositories a snapshot could resolve become baselines.
    const repositories = (snapshot.repositories ?? []).filter(
      (repository): repository is RepositoryBaseline =>
        typeof repository.tree === "string" && repository.tree.length > 0,
    );
    turnBaselines.set(input.sessionId, {
      turnId: input.turnId,
      startedAt: Date.now(),
      closed: false,
      repositories,
      ...(repositories.length === 0 ? { unavailable: "no repository was found in this workspace" } : {}),
    });
    // Validation aid while the pipeline is young: one line per turn, so a
    // missing diff can be told apart from a wrong one at a glance.
    if (import.meta.env.DEV) {
      console.info(
        `[changes] baseline captured session=${input.sessionId} turn=${input.turnId} repositories=${
          repositories.map((repository) => `${repository.repositoryId}@${repository.tree.slice(0, 7)}`).join(",") || "none"
        }`,
      );
    }
  } catch (error) {
    console.warn(
      `[changes] baseline failed session=${input.sessionId} turn=${input.turnId} — this turn will be hint-only`,
      error,
    );
  }
}

/**
 * Read the finished turn's patch from the repository and freeze it.
 *
 * The patch is the diff between the snapshot the turn started from and the one it
 * ended at, so a turn that commits its own work is still reviewable and work the
 * user already had staged or untracked is not attributed to Sofia.
 */
export async function finalizeTurnChangeSet(input: {
  client: WorkspaceChangesClient | null;
  workspaceId: string;
  sessionId: string;
  turnId: string;
}): Promise<void> {
  const client = input.client;
  if (!client) {
    console.warn(`[changes] no client bound for session=${input.sessionId} turn=${input.turnId} — no change set`);
    return;
  }

  // The baseline read is fire-and-forget at turn start, so a short turn can get
  // here while it is still running. Waiting for it is what keeps the turn from
  // being frozen as unattributed over a few milliseconds of latency.
  const pendingBaseline = turnBaselineReads.get(input.sessionId);
  if (pendingBaseline) await pendingBaseline.catch(() => {});

  const record = turnBaselines.get(input.sessionId);
  const usable = record && record.turnId === input.turnId ? record : null;
  try {
    const baselines = usable?.repositories ?? [];
    // Per repository: baselineTree -> endTree for every checkout the turn started
    // with. With no baseline there is nothing to attribute, so the read is the
    // working tree and the set says so rather than claiming the turn did it.
    const snapshot = baselines.length
      ? await readChanges(client, {
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          // The patch is frozen with the set, replay-grade, so Undo and a
          // historical review never re-derive it from a repository that moved on.
          params: { hunks: true, patch: true, baselines },
        })
      : await readChanges(client, {
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          params: { hunks: true },
        });

    const changeSet = changeSetFromRepository({
      sessionId: input.sessionId,
      turnId: input.turnId,
      startedAt: usable?.startedAt ?? Date.now(),
      baseline: null,
      snapshot,
      finalizedAt: Date.now(),
      ...(baselines.length === 0 ? { attributionUnavailable: true } : {}),
    });
    useChangeSetStore.getState().upsert(changeSet);

    const files = changeSet.repositories.flatMap((repository) => repository.files);
    const totals = files.reduce(
      (sum, file) => ({ additions: sum.additions + file.additions, deletions: sum.deletions + file.deletions }),
      { additions: 0, deletions: 0 },
    );
    // `source=tree-delta` is the real pipeline; anything else means the turn is
    // back on a working-tree read and a committed turn will look empty.
    const source = baselines.length ? "tree-delta" : "working-tree";
    if (import.meta.env.DEV) {
      console.info(
        `[changes] finalized changeSet=${changeSet.id} repositories=${changeSet.repositories.length} files=${files.length} +${totals.additions} -${totals.deletions} source=${source}`,
      );
    }
    if (baselines.length === 0) {
      console.warn(
        `[changes] no per-repository baseline for session=${input.sessionId} turn=${input.turnId} — showing working-tree changes without turn attribution`,
      );
    }
    if (usable) turnBaselines.set(input.sessionId, { ...usable, closed: true });
  } catch (error) {
    console.warn(`[changes] finalize failed session=${input.sessionId} turn=${input.turnId}`, error);
  }
}
