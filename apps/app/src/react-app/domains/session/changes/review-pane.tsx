/** @jsxImportSource react */
import * as React from "react";
import { FilePlus2, FileMinus2, FileSymlink, FilePenLine, ImageIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  changeSetFiles,
  changeSetTitle,
  changeSetTotals,
  fileChangeLabel,
  fileChangeNote,
  type ChangeStatus,
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
};

export function ReviewPane({
  scope,
  onScopeChange,
  changeSet,
  repositoryFiles,
  loading = false,
  onOpenFile,
}: ReviewPaneProps) {
  const files = React.useMemo(
    () => (scope === "last-turn" ? (changeSet ? changeSetFiles(changeSet) : []) : (repositoryFiles ?? [])),
    [changeSet, repositoryFiles, scope],
  );
  const [selectedPath, setSelectedPath] = React.useState<string | null>(null);

  // Keep a valid selection as the scope's file list changes.
  const selected = files.find((file) => file.path === selectedPath) ?? files[0] ?? null;

  const totals = changeSet && scope === "last-turn" ? changeSetTotals(changeSet) : null;

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
            {files.map((file) => (
              <button
                key={`${file.oldPath ?? ""}:${file.path}`}
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
                <span className="shrink-0 tabular-nums">
                  <span className="text-emerald-11">+{file.additions}</span>{" "}
                  <span className="text-red-11">−{file.deletions}</span>
                </span>
              </button>
            ))}
          </div>
          <div className="min-w-0 flex-1 overflow-auto">
            {selected ? <DiffView file={selected} onOpenFile={onOpenFile} /> : null}
          </div>
        </div>
      )}
    </div>
  );
}

function DiffView({ file, onOpenFile }: { file: FileChange; onOpenFile?: (path: string) => void }) {
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
          {note ?? "No textual diff available for this file."}
        </div>
      ) : (
        <div data-review-hunks className="min-h-0 flex-1 overflow-auto py-1 font-mono text-[11px] leading-5">
          {hunks.map((hunk, index) => (
            <div key={`${hunk.header}-${index}`} className="min-w-max">
              <div className="bg-muted/50 px-3 text-muted-foreground/80">{hunk.header}</div>
              {hunk.lines.map((line, lineIndex) => (
                <div
                  key={`${lineIndex}-${line.type}-${line.oldLine ?? ""}-${line.newLine ?? ""}`}
                  data-diff-line={line.type}
                  className={cn(
                    "grid grid-cols-[2.5rem_2.5rem_1fr] whitespace-pre",
                    line.type === "add" && "bg-emerald-3/40 text-emerald-11",
                    line.type === "delete" && "bg-red-3/40 text-red-11",
                    line.type === "context" && "text-muted-foreground",
                  )}
                >
                  <span className="select-none px-2 text-right tabular-nums text-muted-foreground/50">
                    {line.oldLine ?? ""}
                  </span>
                  <span className="select-none px-2 text-right tabular-nums text-muted-foreground/50">
                    {line.newLine ?? ""}
                  </span>
                  <span className="px-2">{`${line.type === "add" ? "+" : line.type === "delete" ? "-" : " "}${line.text}`}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
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
