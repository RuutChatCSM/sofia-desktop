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
import { isLongReasoning, reasoningLabel, trackReasoningDuration } from "./reasoning-presentation"

type ReasoningBlockProps = {
  text: string
  isStreaming: boolean
  className?: string
  /** Stable id of this reasoning phase, used to time "Thought for 12s". */
  durationKey?: string
  /**
   * Open on mount, and follow that role as it changes. Used for the reasoning
   * phase Sofia is in *now*: it opens while she is thinking about this step and
   * folds the moment she moves on to commentary or work, so the reader never
   * inherits a stack of expanded thoughts.
   */
  defaultOpen?: boolean
}

/**
 * Thinking is one calm line — "Thinking…" while live, "Thought for 12s" once
 * settled — with the reasoning behind it as a muted, indented aside. Settled
 * reasoning that runs long is capped with "Show more" so opening it never
 * floods the transcript.
 */
export function ReasoningBlock({ text, isStreaming, className, durationKey, defaultOpen = false }: ReasoningBlockProps) {
  "use memo"
  const [open, setOpen] = useState(defaultOpen)
  const [followedDefault, setFollowedDefault] = useState(defaultOpen)
  const [showAll, setShowAll] = useState(false)

  // Follow the phase's role rather than only its first render. A manual toggle
  // in between survives, because `defaultOpen` changes only when the phase does.
  // Adjusted during render, so the phase change costs no extra commit.
  if (followedDefault !== defaultOpen) {
    setFollowedDefault(defaultOpen)
    setOpen(defaultOpen)
  }

  const durationMs = durationKey ? trackReasoningDuration(durationKey, isStreaming, Date.now()) : null
  const label = reasoningLabel({ isStreaming, durationMs })
  // The live phase is being read as it arrives; only a settled one is capped.
  const capped = !isStreaming && !showAll && isLongReasoning(text)

  return (
    <Collapsible open={open} onOpenChange={setOpen} className={cn("w-full", className)} data-reasoning-block="">
      <CollapsibleTrigger
        className="group -mx-1 flex cursor-pointer items-center gap-1.5 rounded-md px-1 text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        data-reasoning-state={isStreaming ? "live" : "settled"}
      >
        <Brain
          aria-hidden="true"
          className={cn("size-3.5 shrink-0", isStreaming && "text-foreground/70 motion-safe:animate-pulse")}
        />
        <span className="tabular-nums">{label}</span>
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
