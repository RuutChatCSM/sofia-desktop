import { isApplyPatchToolPart, isEditToolPart, isWriteToolPart } from "@/lib/build-in-tools";
import type { UIMessage } from "ai";
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
  root?: string;
  /** Paths the turn's tool events touched, in the order they appeared. */
  paths: readonly string[];
  messages?: readonly UIMessage[];
}): TurnChangeSet | null {
  const recorded = new Map<string, { additions: number; deletions: number; patch: string; kind: string }>();
  const calls = new Set<string>();
  const editedPaths = new Set<string>();
  for (const message of input.messages ?? []) for (const part of message.parts) {
    if (part.type !== "dynamic-tool" || part.state !== "output-available" || calls.has(part.toolCallId)) continue;
    if (!isApplyPatchToolPart(part) && !isEditToolPart(part) && !isWriteToolPart(part)) continue;
    calls.add(part.toolCallId);
    const value: unknown = part.input;
    if (value && typeof value === "object" && "filePath" in value && typeof value.filePath === "string") editedPaths.add(value.filePath);
    if (!value || typeof value !== "object" || !("filePath" in value) || typeof value.filePath !== "string" || !("additions" in value) || typeof value.additions !== "number" || !("deletions" in value) || typeof value.deletions !== "number") continue;
    const previous = recorded.get(value.filePath);
    recorded.set(value.filePath, { additions: (previous?.additions ?? 0) + value.additions, deletions: (previous?.deletions ?? 0) + value.deletions, patch: (previous?.patch ? previous.patch + "\n" : "") + ("patch" in value && typeof value.patch === "string" ? value.patch : ""), kind: "changeKind" in value && typeof value.changeKind === "string" ? value.changeKind : "Update" });
  }
  const seen = new Set<string>();
  const files = [];
  for (const path of input.paths) {
    const trimmed = path.trim();
    if (!trimmed || seen.has(trimmed) || (input.messages !== undefined && !editedPaths.has(trimmed))) continue;
    seen.add(trimmed);
    // Status and line counts are unknown from hints: report a modification
    // without pretending to know its size.
    const detail = recorded.get(trimmed);
    files.push({ path: trimmed, status: detail?.kind.toLowerCase() === "add" ? "added" as const : detail?.kind.toLowerCase() === "delete" ? "deleted" as const : "modified" as const, additions: detail?.additions ?? 0, deletions: detail?.deletions ?? 0, recordedPatch: detail?.patch, attributedToTurn: true });
  }
  if (files.length === 0) return null;

  const changeSet = beginTurnChangeSet({
    sessionId: input.sessionId,
    turnId: input.turnId,
    startedAt: input.startedAt,
  });
  return { ...reconcileTurnChangeSet(changeSet, {
    source: "tool-events",
    repositories: [{ repositoryId: "workspace", root: input.root ?? "", files }],
  }), recordedCounts: files.every(file => recorded.has(file.path)) };
}
