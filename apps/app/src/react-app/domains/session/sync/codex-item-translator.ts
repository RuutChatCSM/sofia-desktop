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

/** Expand recorded nested calls without evaluating their original JavaScript. */
export function codexItemToToolParts(item: Record<string,unknown>,sessionId:string,messageId:string,completed=false): DynamicToolUIPart[] {
  if(item.type==="networkStatus")return [{type:"dynamic-tool",toolName:"network_status",toolCallId:str(item.id)||messageId,state:"output-available",input:{message:item.text},output:str(item.text)}];
  if(item.type==="contextCompaction")return [{type:"dynamic-tool",toolName:"context_compaction",toolCallId:str(item.id)||messageId,state:"output-available",input:{},output:"Context automatically compacted"}];
  const args=item.arguments;
  if(item.type==="commandExecution" && Array.isArray(item.commandActions) && item.commandActions.length>1 && item.commandActions.every(action=>isRecord(action)&&["read","search","listFiles"].includes(str(action.type))))return item.commandActions.filter(isRecord).flatMap((action,index)=>{
    const id=`${str(item.id)||messageId}:action:${index}`;
    const part=codexItemToToolPart({...item,id,commandActions:[action]},sessionId,id,completed);return part?[part]:[];
  });
  if(isRecord(args) && Array.isArray(args.nestedCalls))return args.nestedCalls.filter(isRecord).slice(0,200).flatMap((call,index)=>{
    const id=`${str(item.id)||messageId}:nested:${index}`;
    const command=call.command;
    return codexItemToToolParts({...call,id,status:item.status,type:typeof command==="string"?"commandExecution":"dynamicToolCall"},sessionId,id,completed);
  });
  if(item.type==="fileChange" && Array.isArray(item.changes))return item.changes.filter(isRecord).flatMap((change,index)=>{
    const id=`${str(item.id)||messageId}:file:${index}`;
    const diff = typeof change.diff === "string" ? change.diff : undefined;
    const part=codexItemToToolPart({...item,id,path:change.path,changeKind:isRecord(change.kind)?change.kind.type:change.kind, ...(diff === undefined ? {} : {patch:diff,additions:diff.split("\n").filter(line=>line.startsWith("+")&&!line.startsWith("+++")).length,deletions:diff.split("\n").filter(line=>line.startsWith("-")&&!line.startsWith("---")).length})},sessionId,id,completed);
    return part?[part]:[];
  });
  if(item.tool==="apply_patch") {
    const patch=typeof args==="string"?args:isRecord(args)&&typeof args.patch==="string"?args.patch:"";
    const changes=Array.from(patch.matchAll(/^\*\*\* (Add|Update|Delete) File: (.+)$/gm));
    if(changes.length)return changes.map((change,index)=>{
      const end=changes[index+1]?.index ?? patch.length;
      const lines=patch.slice(change.index,end).split("\n");
      const base={type:"dynamic-tool" as const,toolName:"apply_patch",toolCallId:`${str(item.id)||messageId}:file:${index}`,input:{filePath:change[2],changeKind:change[1],patch:patch.slice(change.index,end),additions:lines.filter(line=>line.startsWith("+")).length,deletions:lines.filter(line=>line.startsWith("-")).length}};
      return completed?{...base,state:"output-available" as const,output:""}:{...base,state:"input-streaming" as const};
    });
  }
  const part=codexItemToToolPart(item,sessionId,messageId,completed);return part?[part]:[];
}

/** Map a codex CommandExecution/McpToolCall/DynamicToolCall item to a
 * dynamic-tool part with a canonical toolName so engine's aggregator renders
 * inline "Used X, edited Y" markers (matching the codex app). */
export function codexItemToToolPart(item: Record<string, unknown>, sessionId: string, messageId: string, itemCompleted = false): DynamicToolUIPart | null {
  if (item.type === "subAgentActivity") {
    const threadId = str(item.agentThreadId);
    if (!threadId) return null;
    const kind = str(item.kind);
    const status = kind === "completed" ? "completed" : kind === "interrupted" ? "interrupted" : "running";
    return codexItemToToolPart({
      ...item,
      type: "collabAgentToolCall",
      tool: kind === "started" ? "spawnAgent" : kind === "interacted" ? "sendInput" : kind === "interrupted" ? "interruptAgent" : "wait",
      receiverThreadIds: [threadId],
      agentsStates: { [threadId]: { status } },
      status: "completed",
    }, sessionId, messageId, true);
  }
  const type = item.type;
  const id = str(item.id);
  const tool = type === "commandExecution"
    ? String(item.command ?? "shell")
    : type === "webSearch"
      ? "web_search"
    : type === "collabAgentToolCall"
      ? "collaboration"
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
  // Use the protocol's parsed action, never guess from shell text. A mixed
  // command keeps its command identity because some of its work is unknown.
  const actions = Array.isArray(item.commandActions) ? item.commandActions.filter(isRecord) : [];
  const readAction = actions.length === 1 && actions[0]?.type === "read" ? actions[0] : null;
  const searchAction = actions.length === 1 && (actions[0]?.type === "search" || actions[0]?.type === "listFiles") ? actions[0] : null;
  const lower = tool.toLowerCase();
  const dynamicArgs = isRecord(item.arguments) ? item.arguments : {};
  const isEdit = /\b(edit|write|apply_patch|patch)\b/.test(lower) || type === "fileChange";
  const isRead = /\b(read|cat|view|ls|list|find|glob|grep|search)\b/.test(lower);
  const toolName = isCommand ? "bash" : isEdit ? "apply_patch" : isRead ? "read" : str(item.server) === "node_repl" && tool === "js" ? "node_repl_js" : tool;

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
  const resolvedToolName = tool === "write_stdin" ? "bash" : isBackgroundProcess ? "background_process" : readAction ? "read" : searchAction ? "grep" : toolName;

  // The agent/orchestrator's own words for the operation, when it supplies
  // them; the command is only the fallback title.
  const description = str(item.description).trim();
  const input: Record<string, unknown> = type === "collabAgentToolCall"
    ? { operation: item.tool, agentPath: item.agentPath, prompt: item.prompt, agentsStates: item.agentsStates, receiverThreadIds: item.receiverThreadIds }
    : isBackgroundProcess
    ? { command: item.command, processId: item.processId, cwd: item.cwd, ...(description ? { description } : {}) }
    : readAction
      ? { filePath: str(readAction.path), command: item.command }
    : searchAction
      ? { path: str(searchAction.path), pattern: str(searchAction.query), command: item.command }
    : isCommand
      ? { command: item.command }
      : isEdit
        ? { filePath: str(item.path),changeKind:item.changeKind, ...(typeof item.patch === "string" ? {patch:item.patch,additions:item.additions,deletions:item.deletions} : {}) }
        : type==="webSearch" || tool==="web__run" || tool==="web.run"
          ? {query:str(item.query) || (isRecord(item.arguments) && Array.isArray(item.arguments.search_query)?item.arguments.search_query.filter(isRecord).map(query=>str(query.q)).join(", "):""),arguments:safeJson(item.arguments)}
          : { ...dynamicArgs, arguments: safeJson(item.arguments) };

  const output = str(item.aggregatedOutput) || (typeof item.result === "string" ? item.result : item.result != null ? JSON.stringify(item.result) : "");
  const state: "output-available" | "input-streaming" | "output-error" =
    failed ? "output-error" : completed ? "output-available" : "input-streaming";

  const part: Record<string, unknown> = {
    type: "dynamic-tool",
    toolName: tool==="web__run" || tool==="web.run" || type==="webSearch" ? "websearch" : resolvedToolName,
    toolCallId: id,
    state,
    input,
    callProviderMetadata: { engine: { partId: id, codexItemType: type, codexItemSource: source, codexToolServer: str(item.server), codexToolName: tool } },
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

  if (type === "commandExecution" || type === "mcpToolCall" || type === "dynamicToolCall" || type === "webSearch" || type === "collabAgentToolCall" || type === "subAgentActivity") {
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
