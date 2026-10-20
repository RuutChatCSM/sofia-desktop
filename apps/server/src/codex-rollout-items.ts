import { parseExecActions } from "./codex-exec-actions.js";
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
/** Find a previously emitted item by its call id (to attach tool output). */
function idFromCallId(
  items: Array<{ turnId: string; item: Record<string, unknown> }>,
  callId: string,
): { item: Record<string, unknown> } | null {
  return items.find((entry) => entry.item.id === callId) ?? null;
}


export const TRANSCRIPT_RETAINED_CHARS = 16 * 1024 * 1024;

export function parseRolloutItems(raw: string, limit = 200): Array<{ turnId: string; item: Record<string, unknown> }> {
  return parseRolloutLines(stringLines(raw), limit);
}

function* stringLines(raw: string): Generator<string> {
  let start = 0;
  while (start < raw.length) {
    const end = raw.indexOf("\n", start);
    if (end < 0) { yield raw.slice(start); break; }
    yield raw.slice(start, end);
    start = end + 1;
  }
}

export function parseRolloutLines(lines: Iterable<string>, limit = 200): Array<{ turnId: string; item: Record<string, unknown> }> {
  const out: Array<{ turnId: string; item: Record<string, unknown> }> = [];
  let currentTurn = "";
  const boundaries = new Map<string, { turnStartedAt?: number; turnCompletedAt?: number }>();
  let emitted = 0;
  let retainedChars = 0;
  const sizes = new Map<(typeof out)[number], number>();
  const trim = () => {
    while (out.length > 1 && ((limit > 0 && out.length > limit) || retainedChars > TRANSCRIPT_RETAINED_CHARS)) {
      const removed = out.shift()!;
      retainedChars -= sizes.get(removed) ?? 0;
      sizes.delete(removed);
      if (removed.turnId !== currentTurn && !out.some(entry => entry.turnId === removed.turnId)) boundaries.delete(removed.turnId);
    }
  };
  const append = (entry: (typeof out)[number]) => {
    out.push(entry);
    emitted += 1;
    const size = JSON.stringify(entry.item).length;
    sizes.set(entry, size);
    retainedChars += size;
    trim();
  };
  const resize = (item: Record<string, unknown>) => {
    const entry = out.find(entry => entry.item === item);
    if (!entry) return;
    const size = JSON.stringify(item).length;
    retainedChars += size - (sizes.get(entry) ?? 0);
    sizes.set(entry, size);
    trim();
  };
  for (const line of lines) {
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { continue; }
    if (!isRecord(parsed) || !isRecord(parsed.payload)) continue;
    const payload = parsed.payload;
    const timestamp = typeof parsed.timestamp === "string" ? Date.parse(parsed.timestamp) : NaN;
    const clock = Number.isFinite(timestamp) ? { createdAt: timestamp, completedAt: timestamp } : {};
    if (parsed.type === "compacted" || (parsed.type === "event_msg" && payload.type === "context_compacted")) {
      if (typeof payload.turn_id === "string") currentTurn = payload.turn_id;
      append({turnId:currentTurn,item:{type:"contextCompaction",id:`${currentTurn}:compaction:${emitted}`,status:"completed",...clock}});
      continue;
    }
    if (parsed.type === "event_msg" && payload.type === "item_completed" && isRecord(payload.item) && payload.item.type === "SubAgentActivity") {
      if (typeof payload.turn_id === "string") currentTurn = payload.turn_id;
      const activity = payload.item;
      const id = typeof activity.id === "string" ? activity.id : `${currentTurn}:agent:${emitted}`;
      const threadId = activity.agent_thread_id;
      const canonical = { type: "collabAgentToolCall", id, tool: activity.kind === "started" ? "spawnAgent" : activity.kind === "completed" ? "wait" : "sendInput", agentPath: activity.agent_path, receiverThreadIds: [threadId], agentsStates: typeof threadId === "string" ? { [threadId]: { status: activity.kind === "completed" ? "completed" : "running" } } : {}, status: "completed", ...clock };
      const call = idFromCallId(out, id);
      if (call) { Object.assign(call.item, canonical); resize(call.item); }
      else append({ turnId: currentTurn, item: canonical });
      continue;
    }
    if (parsed.type === "event_msg" && ["stream_error", "reconnecting", "retrying"].includes(String(payload.type))) {
      if (typeof payload.turn_id === "string") currentTurn = payload.turn_id;
      append({turnId:currentTurn,item:{type:"networkStatus",id:`${currentTurn}:network:${emitted}`,text:typeof payload.message === "string" ? payload.message : "Reconnecting… waiting for network",status:"completed",...clock}});
      continue;
    }
    if (parsed.type === "event_msg" || parsed.type === "turn_context") {
      if (typeof payload.turn_id === "string") currentTurn = payload.turn_id;
      if (parsed.type === "event_msg" && currentTurn && Number.isFinite(timestamp)) {
        for (const turnId of boundaries.keys()) {
          if (turnId !== currentTurn && !out.some(entry => entry.turnId === turnId)) boundaries.delete(turnId);
        }
        const previous = boundaries.get(currentTurn) ?? {};
        if (payload.type === "task_started" || payload.type === "turn_started") boundaries.set(currentTurn, { ...previous, turnStartedAt: timestamp });
        if (payload.type === "task_complete" || payload.type === "turn_complete" || payload.type === "turn_aborted") boundaries.set(currentTurn, { ...previous, turnCompletedAt: timestamp });
      }
      continue;
    }
    if (parsed.type !== "response_item") continue;
    const type = payload.type;
    const id = typeof payload.call_id === "string" ? payload.call_id : typeof payload.id === "string" ? payload.id : `${currentTurn}:item:${emitted}`;
    const content = Array.isArray(payload.content) ? payload.content.filter(isRecord) : [];
    const text = content.map(part => typeof part.text === "string" ? part.text : "").filter(Boolean).join("\n");
    let item: Record<string, unknown> | undefined;
    if (type === "message" && payload.role === "user") {
      const parts = content.flatMap<Record<string, unknown>>(part => typeof part.text === "string" ? [{ type: "text", text: part.text }] : part.type === "input_image" && typeof part.image_url === "string" ? [{ type: "image", url: part.image_url }] : []);
      if (parts.length) item = { type: "userMessage", id, content: parts };
    } else if (type === "message" && payload.role === "assistant") {
      item = { type: "agentMessage", id, text, ...(payload.phase === "commentary" || payload.phase === "final_answer" ? { phase: payload.phase } : {}) };
    } else if (type === "reasoning") {
      item = { type: "reasoning", id, content: content.map(part => part.text).filter(value => typeof value === "string"), summary: Array.isArray(payload.summary) ? payload.summary : [] };
    } else if (type === "function_call" || type === "custom_tool_call") {
      const bareName = typeof payload.name === "string" ? payload.name : "tool";
      const name = typeof payload.namespace === "string" ? `${payload.namespace}.${bareName}` : bareName;
      const input = type === "function_call" ? payload.arguments : payload.input;
      let args: unknown = input;
      if (typeof input === "string") { try { args = JSON.parse(input); } catch { /* Custom tools can carry JavaScript. */ } }
      if ((name === "exec" || name === "functions.exec") && type === "custom_tool_call") {
        const code = typeof input === "string" ? input : JSON.stringify(input);
        const nestedCalls = parseExecActions(code);
        const only = nestedCalls.length === 1 ? nestedCalls[0] : undefined;
        item = only?.tool === "exec_command" && typeof only.command === "string"
          ? {type:"commandExecution",id,command:only.command,commandActions:only.commandActions,status:"completed"}
          : {type:"dynamicToolCall",id,tool:name,arguments:{code,nestedCalls},status:"completed"};
      } else item = { type: "dynamicToolCall", id, tool: name, arguments: args, status: "completed" };
    } else if (type === "function_call_output" || type === "custom_tool_call_output") {
      const call = idFromCallId(out, id);
      if (call) {
        if (call.item.type === "commandExecution") call.item.aggregatedOutput = payload.output;
        else call.item.result = payload.output;
        if (Number.isFinite(timestamp)) call.item.completedAt = timestamp;
        resize(call.item);
      }
    }
    if (item) append({ turnId: currentTurn, item: { ...item, ...clock } });
  }
  // Only retained entries are decorated; discarded history never gets copied.
  const timed = out.map(entry => ({ ...entry, item: { ...entry.item, ...boundaries.get(entry.turnId) } }));
  return limit > 0 && timed.length > limit ? timed.slice(-limit) : timed;
}

/** Root durable messages define narrative/order; materialization supplies stable IDs. */
export function reconcileRolloutItems(recorded: Array<{ turnId: string; item: Record<string, unknown> }>, materialized: Array<{ turnId: string; item: Record<string, unknown> }>): Array<{ turnId: string; item: Record<string, unknown> }> {
  if (!recorded.some(entry => entry.item.type === "userMessage") || !recorded.some(entry => entry.item.type === "agentMessage")) return materialized;
  const groupKey = (entry: (typeof recorded)[number]) => JSON.stringify([
    entry.turnId, entry.item.type,
    entry.item.type === "userMessage" || entry.item.type === "agentMessage" ? narrativeContent(entry.item) : null,
  ]);
  const counts = (items: typeof recorded) => {
    const groups = new Map<string, typeof recorded>();
    for (const entry of items) {
      const key = groupKey(entry);
      const group = groups.get(key) ?? [];
      group.push(entry);
      groups.set(key, group);
    }
    return groups;
  };
  const rawGroups = counts(recorded);
  const canonicalGroups = counts(materialized);
  const ordinals = new Map<string, number>();
  return recorded.map(entry => {
    const key = groupKey(entry);
    const ordinal = ordinals.get(key) ?? 0;
    ordinals.set(key, ordinal + 1);
    let match = materialized.find(candidate => candidate.turnId === entry.turnId && candidate.item.id === entry.item.id);
    if (!match && (entry.item.type === "userMessage" || entry.item.type === "agentMessage")) {
      const candidates = canonicalGroups.get(key);
      // Never infer occurrence identity from a truncated group. Intentional
      // repeated messages retain their distinct occurrence and engine IDs.
      if (candidates?.length === rawGroups.get(key)?.length) {
        const candidate = candidates?.[ordinal];
        if (candidate && narrativeContent(candidate.item) === narrativeContent(entry.item)) match = candidate;
      }
    }
    if (!match) return entry;
    if (entry.item.type === "userMessage" || entry.item.type === "agentMessage") {
      return { ...entry, item: { ...entry.item, id: match.item.id, ...(entry.item.id !== match.item.id ? { recordedItemId: entry.item.id } : {}) } };
    }
    if (entry.item.type === "collabAgentToolCall" || entry.item.type === "networkStatus" || entry.item.type === "reasoning") return entry;
    return { ...entry, item: { ...entry.item, ...match.item, ...("createdAt" in entry.item ? { createdAt: entry.item.createdAt } : {}), ...("completedAt" in entry.item ? { completedAt: entry.item.completedAt } : {}) } };
  });
}

function narrativeContent(item: Record<string, unknown>): string {
  if (item.type === "agentMessage") return JSON.stringify([String(item.text ?? "").trim(), item.phase ?? null]);
  const content = Array.isArray(item.content) ? item.content.filter(isRecord).map(part =>
    typeof part.text === "string" ? ["text", part.text.trim()] : [part.type, part.url ?? part.image_url ?? null]) : [];
  return JSON.stringify(content);
}
