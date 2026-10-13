import type { DynamicToolUIPart, ToolUIPart } from "ai"

import {
  isApplyPatchToolPart,
  isBashToolPart,
  isEditToolPart,
  isGlobToolPart,
  isGrepToolPart,
  isReadToolPart,
  isWriteToolPart,
  isWebSearchToolPart,
} from "@/lib/build-in-tools"
import { getToolActivityLabel, isToolPartInFlight } from "@/lib/tool-activity"

export type AnyToolPart = ToolUIPart | DynamicToolUIPart

/**
 * Paper "Recurring actions · aggregate + latest": consecutive tool calls
 * of the same families (commands, file edits, reads, searches) collapse
 * into one aggregate line. Prose from the model always breaks a group.
 */
export type ToolFamily = "command" | "edit" | "read" | "search" | "web" | "skill"

export function getToolFamily(part: AnyToolPart): ToolFamily | null {
  if (isReadToolPart(part) && filePathOf(part)?.split(/[/\\]/).at(-1) === "SKILL.md") return "skill"
  if (isWebSearchToolPart(part)) return "web"
  if (isBashToolPart(part)) return "command"
  if (isEditToolPart(part) || isWriteToolPart(part) || isApplyPatchToolPart(part)) return "edit"
  if (isReadToolPart(part)) return "read"
  if (isGrepToolPart(part) || isGlobToolPart(part)) return "search"
  return null
}

/** The summary uses its leading action family, independent of call order. */
export function getAggregateIconFamily(parts: readonly AnyToolPart[]): ToolFamily {
  const priority: ToolFamily[] = ["skill", "edit", "read", "search", "command", "web"];
  return priority.find(family => parts.some(part => getToolFamily(part) === family)) ?? "command";
}

export function isAggregatableToolPart(part: AnyToolPart): boolean {
  return getToolFamily(part) !== null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function filePathOf(part: AnyToolPart): string | null {
  if (!isRecord(part.input)) return null
  const value = part.input.filePath
  return typeof value === "string" && value ? value : null
}

/**
 * Consecutive actions use a readable family summary; expanding retains each call.
 */
export function getAggregateSummary(parts: AnyToolPart[], tense: "present" | "past"): string {
  const count = (family: ToolFamily) => parts.filter((part) => getToolFamily(part) === family).length
  const pieces: string[] = []
  if (count("skill")) pieces.push(tense === "past" ? "loaded a tool" : "loading a tool")
  if (count("edit")) pieces.push(tense === "past" ? "edited files" : "editing files")
  if (count("read")) pieces.push(tense === "past" ? "read files" : "reading files")
  if (count("search")) pieces.push(tense === "past" ? "searched files" : "searching files")
  const commands = count("command")
  if (commands) pieces.push(`${tense === "past" ? "ran" : "running"} ${commands === 1 ? "a command" : "commands"}`)
  if (count("web")) pieces.push(tense === "past" ? "searched the web" : "searching the web")

  const joined = pieces.join(", ")
  return joined.charAt(0).toUpperCase() + joined.slice(1)
}

export function fileName(path: string): string {
  const segments = path.split(/[/\\]/)
  return segments[segments.length - 1] || path
}

/**
 * File-family rows render as "Edited <name>" with the name clickable
 * (absolute path stays in the tooltip, opens in the artifact view).
 */
export function getAggregateRowFile(part: AnyToolPart): { verb: string; path: string } | null {
  const running = isToolPartInFlight(part)
  const path = filePathOf(part)
  if (!path) return null
  if (getToolFamily(part) === "skill") return null
  if (isEditToolPart(part)) return { verb: running ? "Editing" : "Edited", path }
  if (isWriteToolPart(part)) return { verb: running ? "Writing" : "Wrote", path }
  if (isApplyPatchToolPart(part)) return { verb: running ? "Editing" : "Edited", path }
  if (isReadToolPart(part)) return { verb: running ? "Reading" : "Read", path }
  return null
}

/** Human-readable action text for an expanded aggregate row. */
export function getAggregateRowLabel(part: AnyToolPart): string {
  if (part.callProviderMetadata?.engine?.codexToolName === "write_stdin") return isToolPartInFlight(part) ? "Waiting for command output" : "Checked command output"
  if (getToolFamily(part) === "skill") {
    const name = filePathOf(part)?.split(/[/\\]/).at(-2)?.replace(/[-_]/g, " ") || "skill"
    return `${isToolPartInFlight(part) ? "Loading" : "Read"} ${name} skill`
  }
  if (isBashToolPart(part)) {
    const command = part.input?.command?.trim()
    if (command) return `${isToolPartInFlight(part) ? "Running" : "Ran"} ${command}`
  }
  if (isWebSearchToolPart(part)) return `${isToolPartInFlight(part) ? "Searching" : "Searched"} the web${part.input?.query ? ` for ${part.input.query}` : ""}`
  if (isGrepToolPart(part) || isGlobToolPart(part)) return `${isToolPartInFlight(part) ? "Searching" : "Searched"} files${part.input?.pattern ? ` for ${part.input.pattern}` : ""}`
  return getToolActivityLabel(part)
}

/** Label for the single latest in-flight call — the self-replacing "Now:" line. */
export function getAggregateNowLabel(parts: AnyToolPart[]): string | null {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index]
    if (part && isToolPartInFlight(part)) return getAggregateRowLabel(part)
  }
  return null
}
