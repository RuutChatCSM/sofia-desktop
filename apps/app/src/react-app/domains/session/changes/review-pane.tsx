/** @jsxImportSource react */
/**
 * Side-by-side rows.
 *
 * A hunk arrives as a flat, ordered run of context/deletes/adds. Code is wide, so
 * the default desktop view pairs the old and new sides: context appears on both,
 * a run of deletions is paired row-by-row with the additions that replaced it,
 * and an unbalanced run leaves blank cells rather than shifting the columns.
 */
export type SplitDiffRow = {
  key: string;
  old?: DiffLine;
  new?: DiffLine;
};

export function toSplitDiffRows(lines: readonly DiffLine[]): SplitDiffRow[] {
  const rows: SplitDiffRow[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line) break;
    if (line.type === "context") {
      rows.push({ key: `context-${line.oldLine}-${line.newLine}`, old: line, new: line });
      index += 1;
      continue;
    }

    const deletes: DiffLine[] = [];
    const adds: DiffLine[] = [];
    while (index < lines.length && lines[index]?.type === "delete") {
      deletes.push(lines[index] as DiffLine);
      index += 1;
    }
    while (index < lines.length && lines[index]?.type === "add") {
      adds.push(lines[index] as DiffLine);
      index += 1;
    }

    const height = Math.max(deletes.length, adds.length);
    for (let row = 0; row < height; row += 1) {
      const removed = deletes[row];
      const added = adds[row];
      rows.push({
        key: `change-${removed?.oldLine ?? "x"}-${added?.newLine ?? "x"}`,
        ...(removed ? { old: removed } : {}),
        ...(added ? { new: added } : {}),
      });
    }
  }

  return rows;
}

import * as React from "react";
import { FilePlus2, FileMinus2, FileSymlink, FilePenLine, ImageIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  changeSetByRepository,
  changeSetTitle,
  changeSetTotals,
  fileChangeLabel,
  fileChangeNote,
  type ChangeStatus,
  type DiffHunk,
  type DiffLine,
  type FileChange,
  type TurnChangeSet,
} from "./turn-change-set";

/**
 * Which slice of the repository is being reviewed.
 *
 *   last-turn — the immutable patch of one turn (agent review)
 *   unstaged  — normal working-tree management
 *   staged    — what a commit would record
 *
 * A turn's patch is addressed by its change set id, never re-read from the
 * working tree, so selecting an old turn can never show newer changes.
 */
export type ReviewScope = "last-turn" | "unstaged" | "staged";

export const REVIEW_SCOPES: Array<{ id: ReviewScope; label: string }> = [
  { id: "last-turn", label: "Last turn" },
  { id: "unstaged", label: "Unstaged" },
  { id: "staged", label: "Staged" },
];

export type ReviewPaneProps = {
  scope: ReviewScope;
  onScopeChange: (scope: ReviewScope) => void;
  /** The turn's immutable patch, for the last-turn scope. */
  changeSet?: TurnChangeSet | null;
  /** A repository observation, for the unstaged/staged scopes. */
  repositoryFiles?: FileChange[] | null;
  loading?: boolean;
  onOpenFile?: (path: string) => void;
  /** File to select when the pane opens (from a card row click). */
  initialPath?: string;
};

export function ReviewPane({
  scope,
  onScopeChange,
  changeSet,
  repositoryFiles,
  loading = false,
  onOpenFile,
  initialPath,
}: ReviewPaneProps) {
  // Grouped by repository: a multi-repository change set keeps two files called
  // `src/index.ts` apart, and the headings appear only when there is more than one.
  const groups = React.useMemo(
    () =>
      scope === "last-turn"
        ? changeSet
          ? changeSetByRepository(changeSet)
          : []
        : [{ repositoryId: "", root: "", files: repositoryFiles ?? [] }],
    [changeSet, repositoryFiles, scope],
  );
  const files = React.useMemo(() => groups.flatMap((group) => group.files), [groups]);
  const [selectedPath, setSelectedPath] = React.useState<string | null>(initialPath ?? null);

  // Opening the pane from a file row selects that file; a later row click on the
  // same open tab moves the selection instead of reopening anything.
  React.useEffect(() => {
    if (initialPath) setSelectedPath(initialPath);
  }, [initialPath]);

  // Keep a valid selection as the scope's file list changes.
  const selected = files.find((file) => file.path === selectedPath) ?? files[0] ?? null;

  const totals = changeSet && scope === "last-turn" ? changeSetTotals(changeSet) : null;
  // A turn sourced from tool hints knows which files were touched and nothing
  // about their size; "+0 −0" would be a lie.
  const showCounts = scope === "last-turn" ? Boolean(totals?.countsKnown) : true;

  return (
    <div data-review-pane={scope} className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border/70 px-3 py-2">
        {REVIEW_SCOPES.map((option) => (
          <button
            key={option.id}
            type="button"
            data-review-scope={option.id}
            aria-pressed={scope === option.id}
            onClick={() => onScopeChange(option.id)}
            className={cn(
              "rounded-md px-2 py-1 text-[11px] transition-colors",
              scope === option.id
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
            )}
          >
            {option.label}
          </button>
        ))}
        <span className="ml-auto text-[11px] tabular-nums text-muted-foreground">
          {scope === "last-turn" && changeSet ? changeSetTitle(changeSet) : `${files.length} files`}
          {totals?.countsKnown ? (
            <>
              {" "}
              <span className="text-emerald-11">+{totals.additions}</span>{" "}
              <span className="text-red-11">−{totals.deletions}</span>
            </>
          ) : null}
        </span>
      </div>

      {loading ? (
        <div className="px-3 py-6 text-[12px] text-muted-foreground">Reading the working tree…</div>
      ) : files.length === 0 ? (
        <div className="px-3 py-6 text-[12px] text-muted-foreground">No changes in this scope.</div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <div data-review-files className="w-64 shrink-0 overflow-y-auto border-r border-border/70 py-1">
            {groups.map((group) => (
              <div key={group.repositoryId || "workspace"}>
                {groups.length > 1 ? (
                  <div
                    data-review-repository={group.repositoryId}
                    className="px-3 pb-1 pt-2 text-[10px] uppercase tracking-wide text-muted-foreground/60"
                  >
                    {group.repositoryId} · {group.files.length} files
                  </div>
                ) : null}
                {group.files.map((file) => (
              <button
                key={`${group.repositoryId}:${file.oldPath ?? ""}:${file.path}`}
                type="button"
                data-review-file={file.path}
                onClick={() => {
                  setSelectedPath(file.path);
                  if (file.status === "renamed" && onOpenFile) return;
                }}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] transition-colors",
                  selected?.path === file.path ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50",
                )}
              >
                <StatusIcon status={file.status} />
                <span className="min-w-0 flex-1 truncate font-mono" title={file.path}>
                  {fileChangeLabel(file)}
                </span>
                {file.attributedToTurn ? null : (
                  <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground/70">not Sofia</span>
                )}
                {showCounts ? (
                  <span className="shrink-0 tabular-nums">
                    <span className="text-emerald-11">+{file.additions}</span>{" "}
                    <span className="text-red-11">−{file.deletions}</span>
                  </span>
                ) : null}
              </button>
                ))}
              </div>
            ))}
          </div>
          <div className="min-w-0 flex-1 overflow-auto">
            {selected ? (
              <DiffView file={selected} onOpenFile={onOpenFile} counted={showCounts} />
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}

function DiffView({
  file,
  onOpenFile,
  counted,
}: {
  file: FileChange;
  onOpenFile?: (path: string) => void;
  /** False when the source could not read the repository for this turn. */
  counted: boolean;
}) {
  const note = fileChangeNote(file);
  const hunks = file.hunks ?? [];

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border/70 px-3 py-2">
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground/90" title={file.path}>
          {file.path}
        </span>
        {onOpenFile ? (
          <button
            type="button"
            onClick={() => onOpenFile(file.path)}
            className="shrink-0 rounded-md px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
          >
            Open
          </button>
        ) : null}
      </div>
      {hunks.length === 0 ? (
        <div className="px-3 py-4 text-[12px] text-muted-foreground">
          {note
            ?? (counted
              ? "No textual diff available for this file."
              : "Diff unavailable: this turn was not read from the repository, so only the files Sofia touched are known.")}
        </div>
      ) : (
        <div data-review-hunks className="min-h-0 flex-1 overflow-auto py-1 font-mono text-[11px] leading-5">
          {hunks.map((hunk, index) => (
            <div key={`${hunk.header}-${index}`} className="min-w-max">
              <div className="bg-muted/50 px-3 text-muted-foreground/80">{hunk.header}</div>
              <UnchangedGap hunks={hunks} index={index} />
              {toSplitDiffRows(hunk.lines).map((row) => (
                <div
                  key={row.key}
                  data-diff-row
                  className="grid grid-cols-2 border-t border-border/40 first:border-t-0"
                >
                  <DiffSide line={row.old} side="old" />
                  <DiffSide line={row.new} side="new" />
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** One side of a side-by-side row: line number, marker, text, colour by type. */
function DiffSide({ line, side }: { line?: DiffLine; side: "old" | "new" }) {
  if (!line) {
    return <div data-diff-blank={side} className="grid grid-cols-[2.5rem_1fr] bg-muted/20" />;
  }
  const removed = line.type === "delete";
  const added = line.type === "add";
  return (
    <div
      data-diff-side={side}
      data-diff-line={line.type}
      className={cn(
        "grid grid-cols-[2.5rem_1fr] whitespace-pre",
        added && "bg-emerald-3/40 text-emerald-11",
        removed && "bg-red-3/40 text-red-11",
        !added && !removed && "text-muted-foreground",
      )}
    >
      <span className="select-none px-2 text-right tabular-nums text-muted-foreground/50">
        {(side === "old" ? line.oldLine : line.newLine) ?? ""}
      </span>
      <span className="px-2">{`${added ? "+" : removed ? "-" : " "}${line.text}`}</span>
    </div>
  );
}

/** The stretch of file between two hunks, summarised rather than printed. */
function UnchangedGap({ hunks, index }: { hunks: readonly DiffHunk[]; index: number }) {
  const previous = hunks[index - 1];
  const hunk = hunks[index];
  if (!previous || !hunk) return null;
  const gap = hunk.oldStart - (previous.oldStart + previous.oldLines);
  if (gap <= 1) return null;
  return (
    <div
      data-diff-gap
      className="border-t border-border/40 bg-muted/20 px-3 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground/60"
    >
      {gap} unchanged lines
    </div>
  );
}

function StatusIcon({ status }: { status: ChangeStatus }) {
  const className = "size-3.5 shrink-0 text-muted-foreground";
  if (status === "added") return <FilePlus2 aria-hidden="true" className={className} />;
  if (status === "deleted") return <FileMinus2 aria-hidden="true" className={className} />;
  if (status === "renamed") return <FileSymlink aria-hidden="true" className={className} />;
  if (status === "binary") return <ImageIcon aria-hidden="true" className={className} />;
  return <FilePenLine aria-hidden="true" className={className} />;
}
