import type { TurnChangeSet } from "./turn-change-set";
import { beginTurnChangeSet, reconcileTurnChangeSet } from "./turn-change-set";

/**
 * The **hint** source. Tool events tell us *something* changed and roughly what,
 * and they are all we have until a repository-backed producer exists — but they
 * are not the truth: a shell command, a formatter, a script or an MCP tool can
 * write files with no edit event at all, and the same file can be touched
 * several times.
 *
 * So this produces `source: "tool-events"`, with no line counts (the card must
 * not invent numbers), and it is replaced wholesale the moment a `git`-backed
 * observation arrives.
 */
export function changeSetFromToolHints(input: {
  sessionId: string;
  turnId: string;
  startedAt: number;
  /** Paths the turn's tool events touched, in the order they appeared. */
  paths: readonly string[];
}): TurnChangeSet | null {
  const seen = new Set<string>();
  const files = [];
  for (const path of input.paths) {
    const trimmed = path.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    // Status and line counts are unknown from hints: report a modification
    // without pretending to know its size.
    files.push({ path: trimmed, status: "modified" as const, additions: 0, deletions: 0, attributedToTurn: true });
  }
  if (files.length === 0) return null;

  const changeSet = beginTurnChangeSet({
    sessionId: input.sessionId,
    turnId: input.turnId,
    startedAt: input.startedAt,
  });
  return reconcileTurnChangeSet(changeSet, {
    source: "tool-events",
    repositories: [{ repositoryId: "workspace", root: "", files }],
  });
}
