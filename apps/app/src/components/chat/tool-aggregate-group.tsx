"use client"

import { useState } from "react"
import { BookOpen, Check, CircleAlert, Pencil, Terminal, Globe, Search, ChevronRight, Wrench } from "lucide-react"

import { FileChip } from "@/components/chat/file-chip"
import { ToolImageStrip } from "@/components/chat/tool-image-strip"
import { DotMatrixLoader } from "@/components/ui/dot-matrix-loader"
import {
  getToolFamily,
  getAggregateIconFamily,
  getAggregateNowLabel,
  getAggregateRowFile,
  getAggregateRowLabel,
  getAggregateSummary,
  getToolFailureReason,
  type AnyToolPart,
} from "@/lib/tool-aggregate"
import { isToolPartInFlight } from "@/lib/tool-activity"
import { trackToolCallDuration } from "@/lib/tool-call-duration"
import { toolImagesFor } from "@/lib/tool-images"
import { cn } from "@/lib/utils"

function actionIcon(part: AnyToolPart) {
  const family = getToolFamily(part)
  return family === "skill" ? Wrench : family === "edit" ? Pencil : family === "read" ? BookOpen : family === "web" ? Globe : family === "search" ? Search : Terminal
}

const ROW_CAP = 8

/** Expansion persists per group while the session stays mounted (Paper rule). */
const expandedByGroupKey = new Map<string, boolean>()
const showAllByGroupKey = new Map<string, boolean>()

type ToolAggregateGroupProps = {
  parts: AnyToolPart[]
  className?: string
  /** Session that receives "Comment" annotations from the viewer. */
  sessionId?: string
}

function rowStatus(part: AnyToolPart): "running" | "failed" | "done" {
  if (isToolPartInFlight(part)) return "running"
  if (part.state === "output-error") return "failed"
  return "done"
}

/**
 * Paper "Recurring actions · aggregate + latest": one line with live
 * totals while running plus a self-replacing "Now:" line; past-tense
 * summary when done. Chevron expands the chronological list — action,
 * per-item duration, status (running / done / failed) — capped with
 * "Show N more". A run with a failure opens by itself, so the failure is
 * read rather than hidden behind a count.
 */
export function ToolAggregateGroup({ parts, className, sessionId }: ToolAggregateGroupProps) {
  const groupKey = parts[0]?.toolCallId ?? "aggregate"
  const [chosenExpanded, setExpandedState] = useState(() => expandedByGroupKey.get(groupKey) ?? null)
  const [showAll, setShowAllState] = useState(() => showAllByGroupKey.get(groupKey) ?? false)

  const setExpanded = (value: boolean) => {
    expandedByGroupKey.set(groupKey, value)
    setExpandedState(value)
  }
  const setShowAll = (value: boolean) => {
    showAllByGroupKey.set(groupKey, value)
    setShowAllState(value)
  }

  const anyRunning = parts.some((part) => isToolPartInFlight(part))
  const failedCount = parts.filter((part) => part.state === "output-error").length
  // Until the reader chooses, a failure (even one arriving later) opens the run.
  const expanded = chosenExpanded ?? failedCount > 0
  const summary = getAggregateSummary(parts, anyRunning ? "present" : "past")
  const primaryPart = parts.find(part => getToolFamily(part) === getAggregateIconFamily(parts))
  const SummaryIcon = primaryPart ? actionIcon(primaryPart) : Terminal
  const nowLabel = anyRunning ? getAggregateNowLabel(parts) : null

  // Track durations for every part so each is frozen the moment it completes.
  const durations = parts.map((part) => trackToolCallDuration(part))
  const imagesByPart = parts.map((part) => toolImagesFor(part))
  const runImages = imagesByPart.flat()
  const visibleParts = showAll ? parts : parts.slice(0, ROW_CAP)
  const hiddenCount = parts.length - visibleParts.length

  return (
    <div className={className} data-tool-aggregate={groupKey}>
      <div className="flex min-w-0 max-w-full items-center gap-2">
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
          className="group -mx-1 flex min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-1 text-start text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <SummaryIcon aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate">{summary}</span>
          <ChevronRight
            aria-hidden="true"
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground/70 transition-transform duration-150 motion-reduce:transition-none",
              expanded && "rotate-90",
            )}
          />
          {failedCount > 0 ? (
            <span className="flex shrink-0 items-center gap-1 text-xs text-destructive">
              <CircleAlert aria-hidden="true" className="size-3" />
              {failedCount} failed
            </span>
          ) : null}
        </button>
        <ToolImageStrip images={runImages} latestOnly sessionId={sessionId} />
      </div>

      {nowLabel ? (
        <div className="mt-1 flex min-w-0 items-center gap-2 ps-5 text-sm text-muted-foreground">
          <DotMatrixLoader label={nowLabel} className="text-muted-foreground" />
          <span className="min-w-0 truncate">
            <span className="text-muted-foreground/70">Now: </span>
            {nowLabel}
          </span>
        </div>
      ) : null}

      {expanded ? (
        <div className="mt-1.5 ms-[6px] flex flex-col gap-1 border-s border-border ps-3.5">
          {visibleParts.map((part, index) => {
            const ActionIcon = actionIcon(part)
            const status = rowStatus(part)
            const failure = getToolFailureReason(part)
            const rowImages = imagesByPart[index] ?? []
            return (
              <div key={part.toolCallId} className="flex min-w-0 flex-col gap-0.5">
                <div
                  data-tool-row-status={status}
                  className={cn(
                    "flex min-w-0 items-center gap-2 text-sm",
                    status === "failed" ? "text-destructive" : "text-muted-foreground",
                  )}
                >
                  <ActionIcon aria-hidden="true" className="size-3.5 shrink-0" />
                  {(() => {
                    const file = getAggregateRowFile(part)
                    if (!file) {
                      return (
                        <span className="min-w-0 truncate">
                          {getAggregateRowLabel(part)}
                        </span>
                      )
                    }
                    return (
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="shrink-0">{file.verb}</span>
                        <FileChip
                          path={file.path}
                          range={file.range}
                          diff={file.diff}
                          unavailable={file.unavailable}
                          className="min-w-0"
                        />
                      </span>
                    )
                  })()}
                  {durations[index] ? (
                    <span className="shrink-0 tabular-nums text-muted-foreground/70">
                      {durations[index]}
                    </span>
                  ) : null}
                  <span className="flex size-3.5 shrink-0 items-center justify-center">
                    {status === "running" ? (
                      <DotMatrixLoader label="Running" className="size-3 text-muted-foreground" />
                    ) : status === "failed" ? (
                      <CircleAlert role="img" aria-label="Failed" className="size-3.5" />
                    ) : (
                      <Check role="img" aria-label="Done" className="size-3.5 text-muted-foreground/60" />
                    )}
                  </span>
                </div>
                {status === "failed" ? (
                  <div
                    title={failure?.detail}
                    className="ps-5.5 text-xs text-destructive/80"
                  >
                    {failure?.summary ?? "This step failed"}
                  </div>
                ) : null}
                {rowImages.length ? (
                  <div className="ps-5.5">
                    <ToolImageStrip images={rowImages} viewerImages={runImages} sessionId={sessionId} />
                  </div>
                ) : null}
              </div>
            )
          })}
          {hiddenCount > 0 ? (
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="w-fit text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              Show {hiddenCount} more
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
