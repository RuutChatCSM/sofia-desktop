import {
  baselineFromChanges,
  changeSetFromRepository,
  type TurnBaseline,
  type WorkspaceChangesResponse,
} from "./change-set-source";
import { useChangeSetStore } from "./change-set-store";

/** The slice of the engine client this needs — injected, so it is testable. */
export type WorkspaceChangesClient = {
  git: {
    changes: (params: {
      workspaceId: string;
      hunks?: boolean;
      patch?: boolean;
      snapshot?: boolean;
      baselineTree?: string;
      endTree?: string;
      headBefore?: string | null;
      headAfter?: string | null;
    }) => Promise<WorkspaceChangesResponse>;
  };
};

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
  if (!client?.git) return;
  try {
    const [response, snapshot] = await Promise.all([
      client.git.changes({ workspaceId: input.workspaceId }),
      client.git.changes({ workspaceId: input.workspaceId, snapshot: true }),
    ]);
    const trees = snapshot.tree ? { tree: snapshot.tree, head: snapshot.head ?? null } : null;
    turnBaselines.set(input.sessionId, {
      turnId: input.turnId,
      baseline: baselineFromChanges(response, trees),
      startedAt: Date.now(),
      closed: false,
    });
  } catch {
    // No baseline available; this turn simply has nothing attributable.
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
  if (!client?.git) return;

  const record = turnBaselines.get(input.sessionId);
  const usable = record && record.turnId === input.turnId ? record : null;
  try {
    const baselineTree = usable?.baseline.snapshot?.tree ?? "";
    const end = baselineTree
      ? await client.git.changes({ workspaceId: input.workspaceId, snapshot: true })
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
      ? await client.git.changes({
          workspaceId: input.workspaceId,
          hunks: true,
          patch: true,
          baselineTree: trees.baselineTree,
          endTree: trees.endTree,
          headBefore: trees.headBefore,
          headAfter: trees.headAfter,
        })
      : await client.git.changes({ workspaceId: input.workspaceId, hunks: true });

    useChangeSetStore.getState().upsert(
      changeSetFromRepository({
        sessionId: input.sessionId,
        turnId: input.turnId,
        startedAt: usable?.startedAt ?? Date.now(),
        baseline: usable?.baseline ?? null,
        snapshot,
        finalizedAt: Date.now(),
        ...(trees ? { trees } : {}),
        ...(snapshot.patch ? { patch: snapshot.patch } : {}),
        ...(snapshot.commits ? { commitsInRange: snapshot.commits } : {}),
      }),
    );
    if (usable) turnBaselines.set(input.sessionId, { ...usable, closed: true });
  } catch {
    // Hint-sourced summaries remain for this turn.
  }
}
