// Codex item translator: converts codex/sofia `ThreadItem` objects into the
// opencode `Part` shapes the existing transcript UI renders. Codex emits rich
// discriminated-union items (CommandExecution, McpToolCall, Reasoning,
// AgentMessage, FileChange); opencode's UI consumes text/reasoning/tool/
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
 * dynamic-tool part with a canonical toolName so opencode's aggregator renders
 * inline "Used X, edited Y" markers (matching the codex app). */
export function codexItemToToolPart(item: Record<string, unknown>, sessionId: string, messageId: string): DynamicToolUIPart | null {
  const type = item.type;
  const id = str(item.id);
  const tool = type === "commandExecution"
    ? String(item.command ?? "shell")
    : type === "mcpToolCall" || type === "dynamicToolCall"
      ? str(item.tool)
      : "";
  if (!id || !tool) return null;

  // Canonical opencode toolName so getToolFamily classifies it (bash/edit/
  // write/read/grep/glob). Codex "shell" commands -> bash; codex edits ->
  // apply_patch (which collapses into "edited"). Everything else keeps a label.
  const isCommand = type === "commandExecution";
  const lower = tool.toLowerCase();
  const isEdit = /\b(edit|write|apply_patch|patch)\b/.test(lower) || type === "fileChange";
  const isRead = /\b(read|cat|view|ls|list|find|glob|grep|search)\b/.test(lower);
  const toolName = isCommand ? "bash" : isEdit ? "apply_patch" : isRead ? "read" : tool;

  const status = type === "commandExecution" ? str(item.status) : "";
  const completed = status === "completed";
  const failed = status === "failed" || status === "declined";
  const start = Date.now();

  const input: Record<string, unknown> = isCommand
    ? { command: item.command }
    : isEdit
      ? { filePath: str(item.path) }
      : { arguments: safeJson(item.arguments) };

  const output = str(item.aggregatedOutput) || str(item.result) || "";
  const state: "output-available" | "input-streaming" | "output-error" =
    failed ? "output-error" : completed ? "output-available" : "input-streaming";

  const part: Record<string, unknown> = {
    type: "dynamic-tool",
    toolName,
    toolCallId: id,
    state,
    input,
    callProviderMetadata: { opencode: { partId: id, codexItemType: type } },
  };
  if (completed) part.output = output;
  if (failed) part.errorText = str(item.error) || "tool failed";
  return part as DynamicToolUIPart;
}

/**
 * Convert a codex ThreadItem into opencode Part(s). Returns an array because a
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
    // those make opencode auto-collapse the whole turn into "N steps").
    return toolPart ? [toolPart as unknown as Part] : [];
  }

  if (type === "fileChange") {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    const files = changes.map((c) => (isRecord(c) ? str(c.path) : "")).filter(Boolean);
    return [{
      id: id || `${messageId}:filechange`,
      sessionID: sessionId,
      messageID: messageId,
      type: "patch" as const,
      hash: id,
      files,
    }];
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
