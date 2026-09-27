// Codex item translator: converts codex/sofia `ThreadItem` objects into the
// engine `Part` shapes the existing transcript UI renders. Codex emits rich
// discriminated-union items (CommandExecution, McpToolCall, Reasoning,
// AgentMessage, FileChange); engine's UI consumes text/reasoning/tool/
// step-start parts. This is the harmonization layer between the two engines.
import type { DynamicToolUIPart } from "ai";
import type { Part } from "@/app/lib/engine-types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function safeJson(value: unknown): unknown {
  return value === undefined ? {} : value;
}

/** Map a codex CommandExecution/McpToolCall/DynamicToolCall item to a
 * dynamic-tool part with a canonical toolName so engine's aggregator renders
 * inline "Used X, edited Y" markers (matching the codex app). */
export function codexItemToToolPart(item: Record<string, unknown>, sessionId: string, messageId: string, itemCompleted = false): DynamicToolUIPart | null {
  const type = item.type;
  const id = str(item.id);
  const tool = type === "commandExecution"
    ? String(item.command ?? "shell")
    : type === "fileChange"
      ? "apply_patch"
      : type === "mcpToolCall" || type === "dynamicToolCall"
        ? str(item.tool)
        : "";
  if (!id || !tool) return null;

  // Canonical engine toolName so getToolFamily classifies it (bash/edit/
  // write/read/grep/glob). Codex "shell" commands -> bash; codex edits ->
  // apply_patch (which collapses into "edited"). Everything else keeps a label.
  const isCommand = type === "commandExecution";
  const lower = tool.toLowerCase();
  const isEdit = /\b(edit|write|apply_patch|patch)\b/.test(lower) || type === "fileChange";
  const isRead = /\b(read|cat|view|ls|list|find|glob|grep|search)\b/.test(lower);
  const toolName = isCommand ? "bash" : isEdit ? "apply_patch" : isRead ? "read" : tool;

  const status = str(item.status);
  const completed = itemCompleted || status === "completed";
  const failed = status === "failed" || status === "declined" || item.success === false || Boolean(item.error);
  const start = Date.now();

  // Unified exec reports every command through its startup event, so the source
  // alone says nothing about how long it lives: in one real session all 857
  // command items were "startup" calls that had already exited. Only a process
  // that is still running is the long-lived thing the transcript calls a
  // background process. A finished one is an ordinary shell call — which is
  // what aggregates into "Ran 12 commands" — and hiding those as background
  // activity left the work narrative with no tools in it at all.
  const source = str(item.source);
  const settled = completed || failed;
  const isBackgroundProcess = isCommand && source === "unifiedExecStartup" && !settled;
  const resolvedToolName = isBackgroundProcess ? "background_process" : toolName;

  // The agent/orchestrator's own words for the operation, when it supplies
  // them; the command is only the fallback title.
  const description = str(item.description).trim();
  const input: Record<string, unknown> = isBackgroundProcess
    ? { command: item.command, processId: item.processId, cwd: item.cwd, ...(description ? { description } : {}) }
    : isCommand
      ? { command: item.command }
      : isEdit
        ? { filePath: str(item.path) }
        : { arguments: safeJson(item.arguments) };

  const output = str(item.aggregatedOutput) || (typeof item.result === "string" ? item.result : item.result != null ? JSON.stringify(item.result) : "");
  const state: "output-available" | "input-streaming" | "output-error" =
    failed ? "output-error" : completed ? "output-available" : "input-streaming";

  const part: Record<string, unknown> = {
    type: "dynamic-tool",
    toolName: resolvedToolName,
    toolCallId: id,
    state,
    input,
    callProviderMetadata: { engine: { partId: id, codexItemType: type, codexItemSource: source } },
  };
  if (completed && !failed) part.output = output;
  if (failed) part.errorText = str(item.error) || "tool failed";
  return part as DynamicToolUIPart;
}

/**
 * Convert a codex ThreadItem into engine Part(s). Returns an array because a
 * command item may map to a step-start + tool part for the UI.
 */
export function codexItemToParts(
  item: Record<string, unknown>,
  sessionId: string,
  messageId: string,
  turnId: string,
): Part[] {
  const type = item.type;
  const id = str(item.id);

  if (type === "userMessage") {
    const content = Array.isArray(item.content) ? item.content : [];
    const text = content.map((entry) => (isRecord(entry) ? str(entry.text) : "")).join("");
    return [{
      id: id || `${messageId}:user`,
      sessionID: sessionId,
      messageID: messageId,
      type: "text" as const,
      text,
    }];
  }

  if (type === "agentMessage") {
    const text = str(item.text);
    if (!text) return [];
    return [{
      id: id || `${messageId}:agent`,
      sessionID: sessionId,
      messageID: messageId,
      type: "text" as const,
      text,
    }];
  }

  if (type === "reasoning") {
    const content = Array.isArray(item.content) ? item.content.filter((entry): entry is string => typeof entry === "string") : [];
    const summary = Array.isArray(item.summary) ? item.summary.filter((entry): entry is string => typeof entry === "string") : [];
    const text = [...summary, ...content].join("\n");
    return [{
      id: id || `${messageId}:reasoning`,
      sessionID: sessionId,
      messageID: messageId,
      type: "reasoning" as const,
      text,
      time: { start: Date.now() },
    }];
  }

  if (type === "commandExecution" || type === "mcpToolCall" || type === "dynamicToolCall" || type === "webSearch") {
    const toolPart = codexItemToToolPart(item, sessionId, messageId);
    // Emit a single inline dynamic-tool marker per call (no step-start wrappers —
    // those make engine auto-collapse the whole turn into "N steps").
    return toolPart ? [toolPart as unknown as Part] : [];
  }

  if (type === "fileChange") {
    // One canonical edit marker per changed file. A `patch` part used to be
    // emitted here, which the render-group classifier has no case for: the edit
    // rendered as nothing, and it broke every surrounding aggregate run, so
    // "Edited files" never formed. `apply_patch` is the same marker
    // `commandExecution`→`bash` and edit-named tools already produce, and the
    // aggregator counts unique paths, so one item touching three files must not
    // collapse to a single call.
    const changes = Array.isArray(item.changes) ? item.changes.filter(isRecord) : [];
    return changes
      .map((change, index) => {
        const filePath = str(change.path);
        if (!filePath) return null;
        return codexItemToToolPart(
          { ...item, type: "fileChange", path: filePath },
          sessionId,
          `${id || `${messageId}:filechange`}:${index}`,
        ) as unknown as Part | null;
      })
      .filter((part): part is Part => part !== null);
  }

  if (type === "plan") {
    const text = str(item.text);
    return text ? [{
      id: id || `${messageId}:plan`,
      sessionID: sessionId,
      messageID: messageId,
      type: "text" as const,
      text,
      metadata: { codex: { plan: true } },
    }] : [];
  }

  return [];
}

/** Human label for a codex item type (used for pending states). */
export function codexItemLabel(item: Record<string, unknown>): string {
  const type = item.type;
  switch (type) {
    case "commandExecution": return `shell: ${str(item.command).slice(0, 40)}`;
    case "mcpToolCall": return `mcp: ${str(item.tool)}`;
    case "dynamicToolCall": return `tool: ${str(item.tool)}`;
    case "webSearch": return "web search";
    case "fileChange": return "file change";
    case "reasoning": return "reasoning";
    default: return str(item.type) || "step";
  }
}
