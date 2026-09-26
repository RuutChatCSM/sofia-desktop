/** @jsxImportSource react */
import * as React from "react";
import { ChevronRight, FileDiff } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import {
  type ChangeStatus,
  changeSetByRepository,
  changeSetTitle,
  changeSetTotals,
  fileChangeLabel,
  fileChangeNote,
  isAttributed,
  type FileChange,
  type TurnChangeSet,
} from "./turn-change-set";

const DEFAULT_VISIBLE_FILES = 3;

/**
 * The transcript's result card: a compact summary of an immutable ChangeSet.
 *
 * Deliberately not a diff. The summary lives here; depth belongs in Review. A
 * giant inline diff overwhelms the conversation, and (more importantly) this
 * card must keep addressing *this turn's* patch by id — never "whatever is in
 * the working tree right now".
 */
export function TurnChangeSetCard({
  changeSet,
  onReview,
  onReviewFile,
  onUndo,
  onOpenFile,
  maxVisibleFiles = DEFAULT_VISIBLE_FILES,
}: {
  changeSet: TurnChangeSet;
  onReview?: (changeSetId: string) => void;
  /** Open the review pane on a specific file (a row click). */
  onReviewFile?: (path: string) => void;
  onUndo?: (changeSetId: string) => void;
  /** Opens the file (preview/editor) — the job the old FILES chips did. */
  onOpenFile?: (path: string) => void;
  maxVisibleFiles?: number;
}) {
  const repositories = changeSetByRepository(changeSet);
  const totals = changeSetTotals(changeSet);
  // Significance order across the whole change set; with more than one
  // repository each row says which one it belongs to, so two repositories that
  // both contain `src/index.ts` can never be read as one file.
  // Kept as (repository, file) pairs rather than a path-keyed map: two
  // repositories can both contain `src/index.ts`, and keying by path labelled
  // both rows with whichever repository happened to be last.
  const entries = repositories.flatMap((repository) =>
    repository.files.map((file) => ({ repositoryId: repository.repositoryId, file })),
  );
  const showRepository = repositories.length > 1;
  // A degraded read (no baseline captured) still has counts, but they are the
  // repository's, not this turn's. Only an attributed set may print them or
  // offer Review — anything else would claim work the turn may not have done.
  const attributed = isAttributed(changeSet);
  const trusted = totals.countsKnown && attributed;
  const hasTextualChange = trusted && (totals.additions > 0 || totals.deletions > 0);
  const binaryOnly = trusted && !hasTextualChange;
  const visible = entries.slice(0, maxVisibleFiles);
  const hidden = entries.length - visible.length;

  if (entries.length === 0) return null;

  return (
    <div
      data-turn-changeset={changeSet.id}
      data-changeset-source={changeSet.source}
      className="my-2 w-full overflow-hidden rounded-xl border border-border/70 bg-muted/30"
    >
      <div className="flex items-center gap-3 px-3 py-2">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-background/60">
          <FileDiff className="size-3.5 text-muted-foreground" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium text-foreground">{changeSetTitle(changeSet)}</div>
          {hasTextualChange ? (
            <div className="mt-0.5 flex items-center gap-2 text-[11px] tabular-nums text-muted-foreground">
              <span className="text-emerald-11">+{totals.additions}</span>
              <span className="text-red-11">−{totals.deletions}</span>
            </div>
          ) : binaryOnly ? (
            // A repository-backed set whose only changes are binary has counts,
            // but "+0 −0" would read exactly like nothing happened.
            <div data-changeset-binary-only className="mt-0.5 text-[10px] text-muted-foreground/60">
              Binary changes only
            </div>
          ) : !attributed ? (
            // No baseline was captured, so this is the repository's current
            // state, not the turn's delta. Say so rather than implying the
            // numbers are Sofia's work.
            <div data-changeset-unattributed className="mt-0.5 text-[10px] text-muted-foreground/60">
              Current working-tree changes shown. Turn attribution unavailable.
            </div>
          ) : (
            // Absent counts must not read as "no changes": a hint-sourced set
            // knows which files were touched and nothing about their size.
            <div data-changeset-unmeasured className="mt-0.5 text-[10px] text-muted-foreground/60">
              Change details weren&rsquo;t recorded for this turn.
            </div>
          )}
        </div>
        {onUndo ? (
          <Button variant="ghost" size="sm" onClick={() => onUndo(changeSet.id)}>
            Undo
          </Button>
        ) : null}
        {/* Only a repository-backed set can be reviewed. A hint-sourced set is a
            touched-file list, and a Review button that opens an empty pane is a
            dead end. */}
        {onReview && trusted ? (
          <Button variant="outline" size="sm" onClick={() => onReview(changeSet.id)}>
            Review
          </Button>
        ) : null}
      </div>
      <div className="border-t border-border/70">
        {visible.map(({ repositoryId, file }) => (
          <FileChangeRow
            key={`${repositoryId}:${file.oldPath ?? ""}:${file.path}`}
            file={file}
            showCounts={trusted && hasTextualChange}
            onOpenFile={onOpenFile}
            onReviewFile={onReviewFile && trusted ? () => onReviewFile(file.path) : undefined}
            repository={showRepository ? repositoryId : undefined}
            showTurnAttribution={attributed}
          />
        ))}
      </div>
      {hidden > 0 ? (
        <Collapsible>
          <CollapsibleTrigger className="group flex w-full cursor-pointer items-center gap-1 border-t border-border/70 px-3 py-1.5 text-left text-[11px] text-muted-foreground transition-colors hover:text-foreground">
            Show {hidden} more
            <ChevronRight aria-hidden="true" className="size-3 transition-transform group-data-panel-open:rotate-90" />
          </CollapsibleTrigger>
          <CollapsibleContent className="border-t border-border/70">
            {entries.slice(maxVisibleFiles).map(({ repositoryId, file }) => (
              <FileChangeRow
                key={`${repositoryId}:${file.oldPath ?? ""}:${file.path}`}
                file={file}
                showCounts={trusted && hasTextualChange}
                onOpenFile={onOpenFile}
                onReviewFile={onReviewFile && trusted ? () => onReviewFile(file.path) : undefined}
                repository={showRepository ? repositoryId : undefined}
                showTurnAttribution={attributed}
              />
            ))}
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </div>
  );
}

/** `+` added, `−` removed, `→` renamed, `~` changed, `▣` binary — as in a diff stat. */
function statusMarker(status: ChangeStatus): string {
  if (status === "added") return "+";
  if (status === "deleted") return "−";
  if (status === "renamed") return "→";
  if (status === "binary") return "▣";
  return "~";
}

function FileChangeRow({
  file,
  showCounts,
  onOpenFile,
  onReviewFile,
  repository,
  showTurnAttribution,
}: {
  file: FileChange;
  showCounts: boolean;
  onOpenFile?: (path: string) => void;
  onReviewFile?: () => void;
  /** Shown only when the turn touched more than one repository. */
  repository?: string;
  /**
   * False when the whole set is unattributed. The set-level note already says
   * the changes are not known to be Sofia's, so a per-row "Not from Sofia" would
   * overstate what is actually known.
   */
  showTurnAttribution: boolean;
}) {
  const note = fileChangeNote(file);
  const label = fileChangeLabel(file);
  return (
    <div data-file-change={file.path} className="flex items-center gap-3 px-3 py-1">
      <span
        aria-hidden="true"
        className={cn(
          "w-3 shrink-0 text-center font-mono text-[10px]",
          file.status === "added" && "text-emerald-11",
          file.status === "deleted" && "text-red-11",
          file.status === "renamed" && "text-amber-11",
          (file.status === "modified" || file.status === "binary") && "text-muted-foreground/70",
        )}
      >
        {statusMarker(file.status)}
      </span>
      {onReviewFile || onOpenFile ? (
        <button
          type="button"
          onClick={() => (onReviewFile ? onReviewFile() : onOpenFile?.(file.path))}
          title={file.path}
          className="min-w-0 flex-1 cursor-pointer truncate text-left font-mono text-[11px] text-foreground/90 transition-colors hover:text-foreground"
        >
          {label}
        </button>
      ) : (
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground/90" title={file.path}>
          {repository ? <span className="text-muted-foreground/60">{repository}/</span> : null}
          {label}
        </span>
      )}
      {note ? <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground/70">{note}</span> : null}
      {showCounts ? (
        <span className="flex shrink-0 items-center gap-2 tabular-nums text-[11px]">
          <span className="text-emerald-11">+{file.additions}</span>
          <span className="text-red-11">−{file.deletions}</span>
        </span>
      ) : null}
      {showTurnAttribution && !file.attributedToTurn ? (
        // Pre-existing work the turn did not make: never part of Undo.
        <span className={cn("shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground/70")}>Not from Sofia</span>
      ) : null}
    </div>
  );
}
