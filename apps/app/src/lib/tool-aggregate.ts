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
import type { OpenTargetRange } from "@/react-app/domains/session/artifacts/open-target"
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

export type AggregateRowFile = {
  verb: string
  path: string
  /** What the reader asked to see; the chip opens there. */
  range?: OpenTargetRange
  /** Edit/write/apply_patch: open the call's changes, not the final file. */
  diff?: string
  /** A failed read whose file is gone must not open an empty preview. */
  unavailable?: boolean
}

const SHOWING_LINES_PATTERN = /Showing lines (\d+)-(\d+)(?: of \d+)?/
const NUMBERED_LINE_PATTERN = /^(\d+): ?/gm
const MISSING_FILE_PATTERN = /\b(?:ENOENT|no such file(?: or directory)?|does not exist|cannot find|not found)\b/i
const DIFF_LIKE_PATTERN = /(?:^@@ |\*\*\* Begin Patch|\*\*\* (?:Add|Update|Delete) File:|^\+\+\+ |^--- )/m

function numberField(record: Record<string, unknown>, key: string): number | null {
  const value = record[key]
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null
}

/** The displayed range of a read, from its output when it says so. */
export function readRangeOf(part: AnyToolPart): OpenTargetRange | null {
  if (!isReadToolPart(part)) return null
  if (part.state === "output-available" && typeof part.output === "string") {
    const explicit = SHOWING_LINES_PATTERN.exec(part.output)
    if (explicit) return { start: Number(explicit[1]), end: Number(explicit[2]) }
    const numbered = [...part.output.matchAll(NUMBERED_LINE_PATTERN)].map((match) => Number(match[1]))
    const first = numbered[0]
    const last = numbered[numbered.length - 1]
    if (first !== undefined && last !== undefined) return { start: first, end: last }
  }
  if (!isRecord(part.input)) return null
  // Engine reads treat `offset` as a zero-based line index and `limit` as a count.
  const offset = numberField(part.input, "offset")
  const limit = numberField(part.input, "limit")
  if (offset !== null) return { start: offset + 1, end: Math.max(offset + 1, offset + (limit ?? 1)) }
  if (limit !== null && limit > 0) return { start: 1, end: limit }
  return null
}

function recordDiff(record: Record<string, unknown>): string | null {
  for (const key of ["diff", "patch", "patchText", "text"]) {
    const value = record[key]
    if (typeof value === "string" && value.trim()) return value
  }
  const filediff = record.filediff
  if (isRecord(filediff)) {
    const patch = filediff.patch
    if (typeof patch === "string" && patch.trim()) return patch
  }
  return null
}

function unifiedDiff(path: string, oldText: string, newText: string): string {
  const oldLines = oldText.split("\n")
  const newLines = newText.split("\n")
  return [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
  ].join("\n")
}

function addedFileDiff(path: string, content: string): string {
  const lines = content.split("\n")
  // A generated file can be enormous; the panel is a preview, not the file.
  const visible = lines.slice(0, 1_000)
  return [
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...visible.map((line) => `+${line}`),
    ...(visible.length < lines.length ? [`+… ${lines.length - visible.length} more lines`] : []),
  ].join("\n")
}

/** The diff a call produced, or one synthesized from its input. */
export function toolDiffOf(part: AnyToolPart): string | null {
  if (!isEditToolPart(part) && !isWriteToolPart(part) && !isApplyPatchToolPart(part)) return null
  const path = filePathOf(part) ?? "file"
  const input = isRecord(part.input) ? part.input : {}
  const inputDiff = recordDiff(input)
  if (inputDiff) return inputDiff

  const output = part.state === "output-available" ? part.output : null
  if (typeof output === "string" && DIFF_LIKE_PATTERN.test(output)) return output
  if (isRecord(output)) {
    const diff = recordDiff(output)
    if (diff) return diff
  }

  if (isEditToolPart(part)) {
    const oldText = typeof input.oldString === "string" ? input.oldString : ""
    const newText = typeof input.newString === "string" ? input.newString : ""
    if (oldText || newText) return unifiedDiff(path, oldText, newText)
  }
  if (isWriteToolPart(part) && typeof input.content === "string") return addedFileDiff(path, input.content)
  return null
}

function isMissingFilePart(part: AnyToolPart): boolean {
  return part.state === "output-error" && MISSING_FILE_PATTERN.test(part.errorText)
}

const aggregateRowFileCache = new WeakMap<AnyToolPart, AggregateRowFile | null>()

/**
 * File-family rows render as "Edited <name>" with the name clickable
 * (absolute path stays in the tooltip, opens in the artifact view).
 */
export function getAggregateRowFile(part: AnyToolPart): AggregateRowFile | null {
  const cached = aggregateRowFileCache.get(part)
  if (cached !== undefined) return cached

  const running = isToolPartInFlight(part)
  const path = filePathOf(part)
  let file: AggregateRowFile | null = null
  if (path && getToolFamily(part) !== "skill") {
    if (isEditToolPart(part) || isWriteToolPart(part) || isApplyPatchToolPart(part)) {
      const diff = toolDiffOf(part)
      file = {
        verb: isWriteToolPart(part) ? (running ? "Writing" : "Wrote") : running ? "Editing" : "Edited",
        path,
        ...(diff ? { diff } : {}),
      }
    } else if (isReadToolPart(part)) {
      const range = readRangeOf(part)
      file = {
        verb: running ? "Reading" : "Read",
        path,
        ...(range ? { range } : {}),
        ...(isMissingFilePart(part) ? { unavailable: true } : {}),
      }
    }
  }

  aggregateRowFileCache.set(part, file)
  return file
}

export type ToolFailureReason = { summary: string; detail: string }

function failureTextFromValue(value: unknown, depth = 0): string | null {
  if (depth > 4 || value === null || value === undefined) return null
  if (typeof value === "string") {
    const text = value.trim()
    if (!text) return null
    if (text.startsWith("{") || text.startsWith("[")) {
      try {
        return failureTextFromValue(JSON.parse(text), depth + 1)
      } catch {
        return text
      }
    }
    return text
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const text = failureTextFromValue(entry, depth + 1)
      if (text) return text
    }
    return null
  }
  if (!isRecord(value)) return null
  for (const key of ["error", "errorText", "message", "detail", "reason"]) {
    const text = failureTextFromValue(value[key], depth + 1)
    if (text) return text
  }
  for (const key of ["content", "details", "output", "result"]) {
    const text = failureTextFromValue(value[key], depth + 1)
    if (text) return text
  }
  return null
}

const GENERIC_FAILURE_PATTERN = /^tool failed$/i
const ERROR_HINT_PATTERN = /\b(?:error|failed|denied|not found|enoent|invalid|rejected|unauthori[sz]ed|forbidden|timeout)\b/i

function failureTextFromOutput(value: unknown): string | null {
  if (typeof value !== "string") return failureTextFromValue(value)
  const text = value.trim()
  if (!text) return null
  if (text.startsWith("{") || text.startsWith("[")) return failureTextFromValue(text)
  return ERROR_HINT_PATTERN.test(text) ? text : null
}

/** One line for the failed row; the full reason goes in its tooltip. */
export function getToolFailureReason(part: AnyToolPart): ToolFailureReason | null {
  if (part.state !== "output-error") return null
  const fromError = failureTextFromValue(part.errorText)
  const fromOutput = failureTextFromOutput("output" in part ? part.output : null)
  const reason = fromError && !GENERIC_FAILURE_PATTERN.test(fromError)
    ? fromError
    : fromOutput && !GENERIC_FAILURE_PATTERN.test(fromOutput)
      ? fromOutput
      : null
  if (!reason) return null
  const firstLine = reason.split("\n").map((line) => line.trim()).find(Boolean) ?? reason
  const collapsed = firstLine.replace(/\s+/g, " ")
  const detail = part.errorText && !GENERIC_FAILURE_PATTERN.test(part.errorText) ? part.errorText : reason
  return { summary: collapsed.length > 140 ? `${collapsed.slice(0, 139)}…` : collapsed, detail }
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
