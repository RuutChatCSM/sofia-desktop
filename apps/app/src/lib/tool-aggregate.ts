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
 * Consecutive actions use a readable family summary with counts — "Ran 4
 * commands, edited 2 files" — so the collapsed row says how much happened.
 * Edits and reads count distinct files; expanding retains each call.
 */
export function getAggregateSummary(parts: AnyToolPart[], tense: "present" | "past"): string {
  const ofFamily = (family: ToolFamily) => parts.filter((part) => getToolFamily(part) === family)
  const files = (family: ToolFamily) => {
    const calls = ofFamily(family)
    const paths = new Set(calls.flatMap((part) => filePathOf(part) ?? []))
    return paths.size || calls.length
  }
  const counted = (count: number, one: string, many: string) => (count === 1 ? one : `${count} ${many}`)
  const verb = (past: string, present: string) => (tense === "past" ? past : present)
  const pieces: string[] = []
  const skills = ofFamily("skill").length
  if (skills) pieces.push(`${verb("loaded", "loading")} ${counted(skills, "a tool", "tools")}`)
  const edited = files("edit")
  if (ofFamily("edit").length) pieces.push(`${verb("edited", "editing")} ${counted(edited, "a file", "files")}`)
  const read = files("read")
  if (ofFamily("read").length) pieces.push(`${verb("read", "reading")} ${counted(read, "a file", "files")}`)
  if (ofFamily("search").length) pieces.push(verb("searched files", "searching files"))
  const commands = ofFamily("command").length
  if (commands) pieces.push(`${verb("ran", "running")} ${counted(commands, "a command", "commands")}`)
  if (ofFamily("web").length) pieces.push(verb("searched the web", "searching the web"))

  const joined = pieces.join(", ")
  return joined.charAt(0).toUpperCase() + joined.slice(1)
}

/**
 * The engine runs commands through a login shell (`/bin/zsh -lc '…'`); the
 * reader asked for the command, not the wrapper.
 */
export function displayCommand(command: string): string {
  const wrapped = /^(?:\S*\/)?(?:ba|z)?sh -l?c (['"])([\s\S]*)\1$/.exec(command.trim())
  if (!wrapped?.[2]) return command.trim()
  return wrapped[1] === "'" ? wrapped[2].replaceAll("'\\''", "'") : wrapped[2]
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
    if (command) return `${isToolPartInFlight(part) ? "Running" : "Ran"} ${displayCommand(command)}`
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
