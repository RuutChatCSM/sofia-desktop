"use client"

import { CircleDashed, CircleCheck, CircleX, Terminal } from "lucide-react"
import type { DynamicToolUIPart } from "ai"

import { cn } from "@/lib/utils"

/**
 * Transcript rendering for a unified-exec background process. Unified exec
 * startup is a long-running process, not a one-shot shell call, so it must not
 * read like a `$ command` card. The same component renders both the running
 * state and the exit state (the item only completes when the process exits).
 */
export function BackgroundProcessTool({ part }: { part: DynamicToolUIPart }) {
  const input = (part.input ?? {}) as { command?: unknown; cwd?: unknown; processId?: unknown }
  const command = typeof input.command === "string" && input.command.trim() ? input.command.trim() : "Background task"
  const cwd = typeof input.cwd === "string" ? input.cwd : ""
  const output = typeof part.output === "string" ? part.output.trim() : ""
  const failed = part.state === "output-error"
  const running = part.state === "input-streaming" || part.state === "input-available"

  return (
    <div
      className="my-1.5 flex flex-col gap-1 rounded-lg border border-border/70 bg-muted/30 px-3 py-2 text-[13px]"
      data-testid="background-process-item"
    >
      <div className="flex items-center gap-2">
        <Terminal className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-foreground/90">{command}</code>
        <span
          className={cn(
            "flex shrink-0 items-center gap-1 text-[11px]",
            failed ? "text-red-11" : running ? "text-emerald-11" : "text-muted-foreground",
          )}
        >
          {failed ? (
            <CircleX className="size-3" aria-hidden="true" />
          ) : running ? (
            <CircleDashed className="size-3 animate-spin" aria-hidden="true" />
          ) : (
            <CircleCheck className="size-3" aria-hidden="true" />
          )}
          {failed ? "Failed" : running ? "Running" : "Finished"}
        </span>
      </div>
      {cwd ? <div className="truncate ps-5 text-[11px] text-muted-foreground">{cwd}</div> : null}
      {output ? (
        <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-background/60 p-2 font-mono text-[11px] leading-5 text-muted-foreground">
          {output}
        </pre>
      ) : null}
    </div>
  )
}
