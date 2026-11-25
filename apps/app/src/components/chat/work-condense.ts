import type { DynamicToolUIPart } from "ai"

import { getCapabilityCallSentence } from "@/lib/capability-call"
import { isCollaborationActivity } from "@/lib/collaboration-activity"
import type { TurnWorkEntry } from "./turn-presentation"

/**
 * Settled reasoning this short is a breath between two actions, not a step of
 * its own. It folds into the phase it interrupts instead of taking a row.
 */
export const SHORT_THOUGHT_CHARS = 600

type Thought = TurnWorkEntry & { kind: "thought" }
type Run = TurnWorkEntry & { kind: "milestone" | "capabilityRun" }

function isShortThought(entry: TurnWorkEntry): entry is Thought {
  return entry.kind === "thought" && !entry.isStreaming && !entry.isCurrent && entry.text.length <= SHORT_THOUGHT_CHARS
}

function capabilityPart(entry: TurnWorkEntry, isCapabilityLine: (part: DynamicToolUIPart) => boolean): DynamicToolUIPart | null {
  if (entry.kind !== "detail") return null
  const parts = entry.item.message.parts
  const part = parts.length === 1 ? parts[0] : undefined
  return part?.type === "dynamic-tool" && !isCollaborationActivity(part) && isCapabilityLine(part) ? part : null
}

/**
 * Condense a turn's narrative the way a reader skims it: "Edited 4 files"
 * rather than five "Edited a file" rows split by one-second thoughts.
 *
 * - Short settled thoughts between actions fold into one thought row placed
 *   before the run they interrupted (nothing is dropped; it expands as usual).
 * - Tool milestones merge across those folded thoughts.
 * - Consecutive calls to the same connected service ("Used Browser") become
 *   one capability run.
 * Commentary, long reasoning, steers and anything else still break a run.
 */
export function condenseWork(
  work: readonly TurnWorkEntry[],
  // Only calls the transcript draws as plain capability lines may group;
  // special cards (background processes, questions, subagents…) stay as they are.
  isCapabilityLine: (part: DynamicToolUIPart) => boolean = () => true,
): TurnWorkEntry[] {
  const out: TurnWorkEntry[] = []
  let run: Run | null = null
  let folded: string[] = []

  // Folded reasoning joins the thought row just before the open run, or gets
  // one placed there, so it stays next to the actions it was about.
  const settleFolded = () => {
    if (!run || folded.length === 0) return
    const at = out.indexOf(run)
    const before = out[at - 1]
    if (before?.kind === "thought") before.text = [before.text, ...folded].join("\n\n")
    else out.splice(at, 0, { kind: "thought", key: `${run.key}:thoughts`, text: folded.join("\n\n"), isStreaming: false, isCurrent: false })
    folded = []
  }
  const breakRun = () => {
    settleFolded()
    run = null
  }

  for (const entry of work) {
    if (run && isShortThought(entry)) {
      folded.push(entry.text)
      continue
    }
    if (entry.kind === "milestone") {
      if (run?.kind === "milestone") {
        run.parts.push(...entry.parts)
        settleFolded()
        continue
      }
      breakRun()
      run = { ...entry, parts: [...entry.parts] }
      out.push(run)
      continue
    }
    const part = capabilityPart(entry, isCapabilityLine)
    if (part && entry.kind === "detail") {
      const sentence = getCapabilityCallSentence(part)
      const service = sentence.service ?? part.toolName
      if (run?.kind === "capabilityRun" && run.service === service) {
        run.items.push(entry.item)
        settleFolded()
        continue
      }
      breakRun()
      run = { kind: "capabilityRun", key: entry.key, service, past: sentence.past, items: [entry.item] }
      out.push(run)
      continue
    }
    breakRun()
    out.push(entry.kind === "thought" ? { ...entry } : entry)
  }
  settleFolded()
  // A run of one is just the call: keep its original line.
  return out.map((entry): TurnWorkEntry => {
    const only = entry.kind === "capabilityRun" && entry.items.length === 1 ? entry.items[0] : undefined
    return only ? { kind: "detail", key: entry.key, item: only } : entry
  })
}

/** Live turns show only their latest steps; older ones fold behind a count. */
export const LIVE_STEP_WINDOW = 6

export function windowLiveWork<T>(entries: readonly T[], live: boolean, showAll: boolean): { hidden: number; visible: readonly T[] } {
  if (!live || showAll || entries.length <= LIVE_STEP_WINDOW + 1) return { hidden: 0, visible: entries }
  return { hidden: entries.length - LIVE_STEP_WINDOW, visible: entries.slice(-LIVE_STEP_WINDOW) }
}
