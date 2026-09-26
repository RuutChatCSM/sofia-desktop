import { create } from "zustand";

import { turnChangeSetId, type TurnChangeSet } from "./turn-change-set";

/**
 * Durable change sets, keyed by their immutable id.
 *
 * The store is what makes a historical card safe: it holds the patch summary
 * that belonged to that turn, so rendering an old turn never re-reads the
 * working tree. Re-finalizing an existing id is ignored — a later observation
 * may not rewrite history.
 */
type ChangeSetStore = {
  byId: Record<string, TurnChangeSet>;
  /**
   * The newest set per session. A turn's id is not always carried by the
   * transcript (engine-driven sessions have no codex item turn id), so the card
   * needs a way to find the turn that just finished.
   */
  latestBySession: Record<string, string>;
  upsert: (changeSet: TurnChangeSet) => void;
  clear: () => void;
};

/**
 * Enough to tell whether a re-registration changed anything. The hint-sourced
 * registration runs from a render-adjacent effect and rebuilds its object every
 * render, so a new object must not be treated as a change: notifying subscribers
 * there is a render loop.
 */
function changeSetSignature(changeSet: TurnChangeSet): string {
  return [
    changeSet.id,
    changeSet.source,
    changeSet.finalizedAt ?? "",
    ...changeSet.repositories.flatMap((repository) =>
      repository.files.map(
        (file) =>
          `${file.path}:${file.additions}:${file.deletions}:${file.attributedToTurn ? 1 : 0}`,
      ),
    ),
  ].join("|");
}

export const useChangeSetStore = create<ChangeSetStore>((set) => ({
  byId: {},
  latestBySession: {},
  upsert: (changeSet) =>
    set((state) => {
      const existing = state.byId[changeSet.id];
      if (existing?.finalizedAt !== undefined) return state;
      if (existing && changeSetSignature(existing) === changeSetSignature(changeSet)) return state;
      return {
        byId: { ...state.byId, [changeSet.id]: changeSet },
        latestBySession:
          changeSet.finalizedAt === undefined
            ? state.latestBySession
            : { ...state.latestBySession, [changeSet.sessionId]: changeSet.id },
      };
    }),
  clear: () => set({ byId: {}, latestBySession: {} }),
}));

/** The most recently finalized set for a session, if any. */
export function selectLatestChangeSetForSession(
  byId: Record<string, TurnChangeSet>,
  latestBySession: Record<string, string>,
  sessionId: string,
): TurnChangeSet | null {
  const id = latestBySession[sessionId];
  return id ? byId[id] ?? null : null;
}

export function selectTurnChangeSet(
  byId: Record<string, TurnChangeSet>,
  sessionId: string,
  turnId: string | null | undefined,
): TurnChangeSet | null {
  if (!turnId) return null;
  return byId[turnChangeSetId(sessionId, turnId)] ?? null;
}
