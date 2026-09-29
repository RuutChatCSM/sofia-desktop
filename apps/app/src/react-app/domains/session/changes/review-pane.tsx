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
import { FilePlus2, FileMinus2, FileSymlink, FilePenLine, ImageIcon, FolderOpen, Columns2, WrapText } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  highlightCode,
  hunkSideText,
  type HighlightedLine,
} from "./diff-highlight";
import {
  changeSetByRepository,
  type RepositoryFiles,
  changeSetTitle,
  changeSetTotals,
  fileChangeLabel,
  fileChangeNote,
  isAttributed,
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
        : ([{ repositoryId: "", root: "", files: repositoryFiles ?? [] }] satisfies RepositoryFiles[]),
    [changeSet, repositoryFiles, scope],
  );
  const [showFiles, setShowFiles] = React.useState(false);
  const [filter, setFilter] = React.useState("");
  const [split, setSplit] = React.useState(true);
  const [wrap, setWrap] = React.useState(true);
  const files = React.useMemo(() => groups.flatMap((group) => group.files), [groups]);
  const [selectedPath, setSelectedPath] = React.useState<string | null>(initialPath ?? null);

  // Opening the pane from a file row selects that file; a later row click on the
  // same open tab moves the selection instead of reopening anything.
  React.useEffect(() => {
    if (initialPath) setSelectedPath(initialPath);
  }, [initialPath]);

  // Keep a valid selection as the scope's file list changes.
  const selected = files.find((file) => file.path === selectedPath) ?? files[0] ?? null;

  const turnTotals = changeSet && scope === "last-turn" ? changeSetTotals(changeSet) : null;
  // Live scopes compute their own aggregate: Unstaged/Staged were showing a file
  // count with no sense of magnitude.
  const liveTotals = React.useMemo(
    () =>
      files.reduce(
        (sum, file) => ({ additions: sum.additions + file.additions, deletions: sum.deletions + file.deletions }),
        { additions: 0, deletions: 0 },
      ),
    [files],
  );
  const totals = turnTotals ?? { ...liveTotals, files: files.length, countsKnown: files.length > 0 };
  // A turn sourced from tool hints knows which files were touched and nothing
  // about their size; "+0 −0" would be a lie.
  // An unattributed set is the repository's current state, not the turn's delta,
  // so its counts must not be printed under "Last turn".
  const turnAttributed = changeSet ? isAttributed(changeSet) : true;
  const showCounts = scope === "last-turn" ? Boolean(totals?.countsKnown) && turnAttributed : true;

  return (
    <div data-review-pane={scope} className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border/70 px-3 py-2">
        <select aria-label="Review scope" value={scope} className="rounded-full bg-muted px-3 py-1.5 text-xs" onChange={(event) => {
          const option = REVIEW_SCOPES.find((item) => item.id === event.target.value);
          if (option) onScopeChange(option.id);
        }}>{REVIEW_SCOPES.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select>
        <span className="ml-auto text-[11px] tabular-nums text-muted-foreground">
          {scope === "last-turn" && changeSet
            ? turnAttributed
              ? changeSetTitle(changeSet)
              : "Working-tree changes"
            : `${files.length} files`}
          {showCounts ? (
            <>
              {" "}
              <span className="text-emerald-11">+{totals.additions}</span>{" "}
              <span className="text-red-11">−{totals.deletions}</span>
            </>
          ) : null}
        </span>
        <div className="flex items-center gap-1 rounded-full bg-muted px-1 [&_svg]:size-4 [&_svg]:stroke-[1.5]">
          <button type="button" aria-label="Toggle split diff" aria-pressed={split} className="p-2" onClick={() => setSplit(!split)}><Columns2 /></button>
          <button type="button" aria-label="Wrap diff lines" aria-pressed={wrap} className="p-2" onClick={() => setWrap(!wrap)}><WrapText /></button>
          <button type="button" aria-label="Toggle changed files" aria-pressed={showFiles} className="p-2" onClick={() => setShowFiles(!showFiles)}><FolderOpen /></button>
        </div>
      </div>

      {loading ? (
        <div className="px-3 py-6 text-[12px] text-muted-foreground">Reading the working tree…</div>
      ) : files.length === 0 ? (
        <div className="px-3 py-6 text-[12px] text-muted-foreground">No changes in this scope.</div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {showFiles ? <div data-review-files className="order-2 w-60 max-w-[40%] shrink-0 overflow-y-auto border-l border-border/70 py-1">
            <div className="p-2"><input aria-label="Filter changed files" placeholder="Filter files…" value={filter} onChange={(event) => setFilter(event.target.value)} className="w-full rounded-md border border-border bg-transparent px-2 py-1 text-xs" /></div>
            {groups.filter((group) => group.files.length > 0).map((group) => (
              <div key={group.repositoryId || "workspace"}>
                {groups.length > 1 ? (
                  <div
                    data-review-repository={group.repositoryId}
                    className="px-3 pb-1 pt-2 text-[10px] uppercase tracking-wide text-muted-foreground/60"
                  >
                    {group.repositoryId} · {group.files.length} files
                  </div>
                ) : null}
                {group.files.filter((file) => file.path.toLowerCase().includes(filter.toLowerCase())).map((file) => (
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
                {turnAttributed && !file.attributedToTurn ? (
                  <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground/70">not Sofia</span>
                ) : null}
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
          </div> : null}
          <div className="min-w-0 flex-1 overflow-auto">
            {selected ? (
              <DiffView file={selected} onOpenFile={onOpenFile} counted={showCounts} split={split} wrap={wrap} />
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}

type HunkHighlight = { old: HighlightedLine[]; new: HighlightedLine[] };

function DiffView({
  file,
  onOpenFile,
  counted,
  split,
  wrap,
}: {
  file: FileChange;
  onOpenFile?: (path: string) => void;
  /** False when the source could not read the repository for this turn. */
  counted: boolean;
  split: boolean;
  wrap: boolean;
}) {
  const note = fileChangeNote(file);
  const hunks = file.hunks ?? [];
  const [highlighted, setHighlighted] = React.useState<HunkHighlight[] | null>(null);

  // Highlight the frozen hunks, not a re-read of the repository. Until the
  // tokens resolve the rows render as plain text, so the diff is never wrong —
  // only uncoloured.
  React.useEffect(() => {
    if (hunks.length === 0) {
      setHighlighted(null);
      return;
    }
    let cancelled = false;
    setHighlighted(null);
    void (async () => {
      const next = await Promise.all(
        hunks.map(async (hunk) => ({
          old: await highlightCode(hunkSideText(hunk, "old"), file.path),
          new: await highlightCode(hunkSideText(hunk, "new"), file.path),
        })),
      );
      if (!cancelled) setHighlighted(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [file, hunks]);

  return (
    <div className="flex min-h-0 flex-col">
      {/* Stays put while a long file scrolls: the header is a flex sibling of the
          scroller, and sticky so it also survives any future nesting. */}
      <div className="sticky top-0 z-10 flex shrink-0 items-center gap-2 border-b border-border/70 bg-dls-canvas px-3 py-2">
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
            <div key={`${hunk.header}-${index}`} className="min-w-0">
              <div className="bg-muted/50 px-3 text-muted-foreground/80">{hunk.header}</div>
              <UnchangedGap hunks={hunks} index={index} />
              <HunkRows hunk={hunk} highlight={highlighted?.[index]} split={split} wrap={wrap} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The rows of one hunk. Token lines are consumed in row order for each side, so
 * a highlighted line always sits beside the line it came from.
 */
function HunkRows({ hunk, highlight, split, wrap }: { hunk: DiffHunk; highlight?: HunkHighlight; split: boolean; wrap: boolean }) {
  if (!split) return <>{hunk.lines.map((line, index) => <DiffSide key={index} line={line} side={line.type === "delete" ? "old" : "new"} wrap={wrap} />)}</>;
  return <SplitHunkRows hunk={hunk} highlight={highlight} wrap={wrap} />;
}

function SplitHunkRows({ hunk, highlight, wrap }: { hunk: DiffHunk; highlight?: HunkHighlight; wrap: boolean }) {
  const rows = React.useMemo(() => toSplitDiffRows(hunk.lines), [hunk.lines]);
  let oldCursor = 0;
  let newCursor = 0;

  return (
    <>
      {rows.map((row) => {
        const oldTokens = row.old ? highlight?.old[oldCursor] : undefined;
        const newTokens = row.new ? highlight?.new[newCursor] : undefined;
        if (row.old) oldCursor += 1;
        if (row.new) newCursor += 1;
        return (
          <div key={row.key} data-diff-row className="grid grid-cols-2 border-t border-border/40 first:border-t-0">
            <DiffSide line={row.old} side="old" tokens={oldTokens} wrap={wrap} />
            <DiffSide line={row.new} side="new" tokens={newTokens} wrap={wrap} />
          </div>
        );
      })}
    </>
  );
}

/** One side of a side-by-side row: line number, marker, text, colour by type. */
function DiffSide({
  line,
  side,
  tokens,
  wrap,
}: {
  line?: DiffLine;
  side: "old" | "new";
  tokens?: HighlightedLine;
  wrap: boolean;
}) {
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
        "grid min-w-0 grid-cols-[2.5rem_minmax(0,1fr)] border-r border-border/40",
        wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre overflow-x-auto",
        added && "bg-emerald-3/40 text-emerald-11",
        removed && "bg-red-3/40 text-red-11",
        !added && !removed && "text-muted-foreground",
      )}
    >
      <span className="select-none px-2 text-right tabular-nums text-muted-foreground/50">
        {(side === "old" ? line.oldLine : line.newLine) ?? ""}
      </span>
      <span className="px-2">
        {added ? "+" : removed ? "-" : " "}
        {tokens && tokens.length > 0
          ? tokens.map((token, index) => (
              <span key={index} style={token.color ? { color: token.color } : undefined}>
                {token.text}
              </span>
            ))
          : line.text}
      </span>
    </div>
  );
}

/** The stretch of file between two hunks, summarised rather than printed. */
function UnchangedGap({ hunks, index }: { hunks: readonly DiffHunk[]; index: number }) {
  const previous = hunks[index - 1];
  const hunk = hunks[index];
  if (!hunk) return null;
  const gap = previous ? hunk.oldStart - (previous.oldStart + previous.oldLines) : hunk.oldStart - 1;
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
