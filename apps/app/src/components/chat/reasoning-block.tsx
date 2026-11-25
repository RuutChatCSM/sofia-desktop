"use client"

import { useState } from "react"
import { Brain, ChevronRight } from "lucide-react"

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { MessageContent } from "@/components/ui/message"
import { cn } from "@/lib/utils"
import { isLongReasoning, latestReasoningLine, reasoningLabel, trackReasoningDuration } from "./reasoning-presentation"

type ReasoningBlockProps = {
  text: string
  isStreaming: boolean
  className?: string
  /** Stable id of this reasoning phase, used to time "Thought for 12s". */
  durationKey?: string
}

/**
 * Thinking is one line. While live: a shimmering "Thinking" with the newest
 * line of reasoning sliding in beside it, so the reader sees progress without
 * a wall of streaming text. Once settled: "Thought for 12s". The full
 * reasoning is a muted, indented aside that opens only when asked for;
 * settled reasoning that runs long is capped with "Show more".
 */
export function ReasoningBlock({ text, isStreaming, className, durationKey }: ReasoningBlockProps) {
  "use memo"
  const [open, setOpen] = useState(false)
  const [showAll, setShowAll] = useState(false)

  const durationMs = durationKey ? trackReasoningDuration(durationKey, isStreaming, Date.now()) : null
  const label = reasoningLabel({ isStreaming, durationMs })
  // The live phase is being read as it arrives; only a settled one is capped.
  const capped = !isStreaming && !showAll && isLongReasoning(text)
  const live = isStreaming && !open ? latestReasoningLine(text) : null

  return (
    <Collapsible open={open} onOpenChange={setOpen} className={cn("w-full", className)} data-reasoning-block="">
      <CollapsibleTrigger
        className={cn(
          "group -mx-1 flex max-w-full cursor-pointer items-center gap-1.5 rounded-md px-1 text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
          live?.line && "w-full",
        )}
        data-reasoning-state={isStreaming ? "live" : "settled"}
      >
        <Brain
          aria-hidden="true"
          className={cn("size-3.5 shrink-0", isStreaming && "text-foreground/70 motion-safe:animate-pulse")}
        />
        <span className={cn("shrink-0 tabular-nums", isStreaming && "motion-safe:ow-text-shimmer")}>{label}</span>
        {live?.line ? (
          // Keyed by where the line starts, so each new thought slides in once
          // instead of the row re-animating on every token.
          <span
            key={live.start}
            className="min-w-0 flex-1 truncate text-start text-muted-foreground/80 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-1 motion-safe:duration-300"
          >
            {live.line}
          </span>
        ) : null}
        <ChevronRight
          aria-hidden="true"
          className="size-3.5 shrink-0 text-muted-foreground/70 transition-transform duration-150 group-data-panel-open:rotate-90 motion-reduce:transition-none"
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-150 ease-out data-starting-style:h-0 data-ending-style:h-0 motion-reduce:transition-none [&[hidden]:not([hidden='until-found'])]:hidden">
        <div className="mt-1.5 ms-[6px] border-s border-border ps-3.5">
          <div
            data-reasoning-capped={capped ? "" : undefined}
            className={cn(capped && "max-h-72 overflow-hidden mask-b-from-60%")}
          >
            <MessageContent
              markdown
              isStreaming={isStreaming}
              className="w-full min-w-0 rounded-none bg-transparent p-0 text-[13px] leading-6 text-muted-foreground"
            >
              {text}
            </MessageContent>
          </div>
          {!isStreaming && isLongReasoning(text) ? (
            <button
              type="button"
              aria-expanded={showAll}
              onClick={() => setShowAll(!showAll)}
              className="mt-1 rounded-sm text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              {showAll ? "Show less" : "Show more"}
            </button>
          ) : null}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
