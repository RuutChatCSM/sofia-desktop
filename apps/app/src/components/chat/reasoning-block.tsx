"use client"

import { useEffect, useState } from "react"
import { ChevronDown } from "lucide-react"

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { MessageContent } from "@/components/ui/message"
import { cn } from "@/lib/utils"

type ReasoningBlockProps = {
  text: string
  isStreaming: boolean
  className?: string
  /**
   * Open on mount, and follow that role as it changes. Used for the reasoning
   * phase Sofia is in *now*: it opens while she is thinking about this step and
   * folds the moment she moves on to commentary or work, so the reader never
   * inherits a stack of expanded thoughts.
   */
  defaultOpen?: boolean
}

/**
 * Thinking is collapsed by default — a single "Thinking… / Thought"
 * line with a chevron; the full reasoning renders as markdown only
 * when the user opens it.
 */
export function ReasoningBlock({ text, isStreaming, className, defaultOpen = false }: ReasoningBlockProps) {
  const [open, setOpen] = useState(defaultOpen)

  // Follow the phase's role rather than only its first render. A manual toggle
  // in between survives, because `defaultOpen` changes only when the phase does.
  useEffect(() => {
    setOpen(defaultOpen)
  }, [defaultOpen])

  return (
    <Collapsible open={open} onOpenChange={setOpen} className={cn("w-full", className)} data-reasoning-block="">
      <CollapsibleTrigger className="group flex cursor-pointer items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground">
        <span className={cn(isStreaming && "animate-pulse")}>
          {isStreaming ? "Thinking…" : "Thought"}
        </span>
        <ChevronDown
          aria-hidden="true"
          className="size-3.5 text-muted-foreground/70 transition-transform duration-150 group-data-panel-open:rotate-180"
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-150 ease-out data-starting-style:h-0 data-ending-style:h-0 [&[hidden]:not([hidden='until-found'])]:hidden">
        <MessageContent
          markdown
          isStreaming={isStreaming}
          className="text-muted-foreground prose mt-1 w-full min-w-0 rounded-lg bg-transparent p-0 text-sm"
        >
          {text}
        </MessageContent>
      </CollapsibleContent>
    </Collapsible>
  )
}
