import {
  baselineFromChanges,
  changeSetFromRepository,
  type TurnBaseline,
  type WorkspaceChangesResponse,
} from "./change-set-source";
import { useChangeSetStore } from "./change-set-store";

/** The read parameters, shared by both client shapes. */
export type WorkspaceChangeParams = {
  hunks?: boolean;
  patch?: boolean;
  snapshot?: boolean;
  baselineTree?: string;
  endTree?: string;
  headBefore?: string | null;
  headAfter?: string | null;
};

/**
 * Either client works: the workspace-scoped one (`git.changes`) is preferred
 * because it does not care which engine drives a session, and the codex
 * session-scoped one (`workspaceChanges`) is the fallback for a session whose
 * engine client is not bound. Injected rather than imported, so it is testable.
 */
export type WorkspaceChangesClient = {
  git?: { changes?: (params: { workspaceId: string } & WorkspaceChangeParams) => Promise<WorkspaceChangesResponse> };
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
const turnBaselines = new Map<string, { turnId: string; baseline: TurnBaseline; startedAt: number; closed: boolean }>();

export function resetTurnBaselines(): void {
  turnBaselines.clear();
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
    const [response, snapshot] = await Promise.all([
      readChanges(client, { workspaceId: input.workspaceId, sessionId: input.sessionId, params: {} }),
      readChanges(client, {
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        params: { snapshot: true },
      }),
    ]);
    const trees = snapshot.tree ? { tree: snapshot.tree, head: snapshot.head ?? null } : null;
    turnBaselines.set(input.sessionId, {
      turnId: input.turnId,
      baseline: baselineFromChanges(response, trees),
      startedAt: Date.now(),
      closed: false,
    });
    // Validation aid while the pipeline is young: one line per turn, so a
    // missing diff can be told apart from a wrong one at a glance.
    if (import.meta.env.DEV) {
      console.info(
        `[changes] baseline captured session=${input.sessionId} turn=${input.turnId} tree=${trees?.tree ?? "none"}`,
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

  const record = turnBaselines.get(input.sessionId);
  const usable = record && record.turnId === input.turnId ? record : null;
  try {
    const baselineTree = usable?.baseline.snapshot?.tree ?? "";
    const end = baselineTree
      ? await readChanges(client, { workspaceId: input.workspaceId, sessionId: input.sessionId, params: { snapshot: true } })
      : null;
    const trees =
      baselineTree && end?.tree
        ? {
            baselineTree,
            endTree: end.tree,
            headBefore: usable?.baseline.snapshot?.head ?? null,
            headAfter: end.head ?? null,
          }
        : undefined;
    const snapshot = trees
      ? await readChanges(client, {
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          params: {
            hunks: true,
            patch: true,
            baselineTree: trees.baselineTree,
            endTree: trees.endTree,
            headBefore: trees.headBefore,
            headAfter: trees.headAfter,
          },
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
      baseline: usable?.baseline ?? null,
      snapshot,
      finalizedAt: Date.now(),
      ...(trees ? { trees } : {}),
      ...(snapshot.patch ? { patch: snapshot.patch } : {}),
      ...(snapshot.commits ? { commitsInRange: snapshot.commits } : {}),
      ...(snapshot.repositories?.length ? { repositories: snapshot.repositories } : {}),
    });
    useChangeSetStore.getState().upsert(changeSet);

    const files = changeSet.repositories.flatMap((repository) => repository.files);
    const totals = files.reduce(
      (sum, file) => ({ additions: sum.additions + file.additions, deletions: sum.deletions + file.deletions }),
      { additions: 0, deletions: 0 },
    );
    // `source=tree-delta` is the real pipeline; anything else means the turn is
    // back on a working-tree read and a committed turn will look empty.
    const source = trees ? "tree-delta" : "working-tree";
    if (import.meta.env.DEV) {
      console.info(
        `[changes] finalized changeSet=${changeSet.id} files=${files.length} +${totals.additions} -${totals.deletions} source=${source}`,
      );
    }
    if (!trees) {
      console.warn(
        `[changes] no baseline for session=${input.sessionId} turn=${input.turnId} — cards will fall back to tool-event hints`,
      );
    }
    if (usable) turnBaselines.set(input.sessionId, { ...usable, closed: true });
  } catch (error) {
    console.warn(`[changes] finalize failed session=${input.sessionId} turn=${input.turnId}`, error);
  }
}
