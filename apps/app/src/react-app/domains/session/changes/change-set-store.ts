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
  upsert: (changeSet: TurnChangeSet) => void;
  clear: () => void;
};

export const useChangeSetStore = create<ChangeSetStore>((set) => ({
  byId: {},
  upsert: (changeSet) =>
    set((state) => {
      const existing = state.byId[changeSet.id];
      if (existing?.finalizedAt !== undefined) return state;
      return { byId: { ...state.byId, [changeSet.id]: changeSet } };
    }),
  clear: () => set({ byId: {} }),
}));

export function selectTurnChangeSet(
  byId: Record<string, TurnChangeSet>,
  sessionId: string,
  turnId: string | null | undefined,
): TurnChangeSet | null {
  if (!turnId) return null;
  return byId[turnChangeSetId(sessionId, turnId)] ?? null;
}
