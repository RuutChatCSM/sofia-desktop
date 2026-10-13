import type { UIMessage } from "ai";
import { isTaskToolPart, type TaskToolPart } from "@/lib/build-in-tools";

export type SessionSubagent = { id: string; title: string; status: "working" | "done" | "failed" | "stopped" | "unknown"; part?: TaskToolPart; message?: string; threadId?: string; updatedAt?: string };

/** Actual engine task calls, deduplicated across replayed message boundaries. */
export function deriveSessionSubagents(messages: readonly UIMessage[]): SessionSubagent[] {
  const agents = new Map<string, SessionSubagent>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts) {
      if (part.type !== "dynamic-tool" || !isTaskToolPart(part)) continue;
      const status = part.state === "output-available" ? part.input?.background ? "unknown" : "done" : part.state === "output-error" || part.state === "output-denied" ? "failed" : "working";
      agents.set(part.toolCallId, { id: part.toolCallId, title: part.input?.description?.trim() || "Subagent task", status, part });
    }
  }
  return [...agents.values()];
}

export function summarizeSessionSubagents(agents: readonly SessionSubagent[]) {
  const working = agents.filter(agent => agent.status === "working");
  const done = agents.filter(agent => agent.status === "done");
  const failed = agents.filter(agent => agent.status === "failed");
  const stopped = agents.filter(agent => agent.status === "stopped");
  const unknown = agents.filter(agent => agent.status === "unknown");
  return { working: working.length, done: done.length, failed: failed.length, stopped: stopped.length, unknown: unknown.length, avatars: (working.length ? working : [...done, ...failed, ...stopped, ...unknown]).slice(0, 4) };
}

/** Canonical Codex agent state, independent of whether transcript renders the collab call. */
export function deriveCodexSubagents(items: readonly { item: Record<string, unknown> }[]): SessionSubagent[] {
  const agents = new Map<string, SessionSubagent>();
  for (const tracked of items) {
    const source = tracked.item;
    const nativeId = typeof source.agentThreadId === "string" ? source.agentThreadId : "";
    const item = source.type === "subAgentActivity" && nativeId
      ? { ...source, type: "collabAgentToolCall", agentsStates: { [nativeId]: { status: source.kind === "completed" ? "completed" : source.kind === "interrupted" ? "interrupted" : "running" } } }
      : source;
    if (item.type !== "collabAgentToolCall") continue;
    const states = item.agentsStates ?? (Array.isArray(item.receiverThreadIds) && item.tool === "spawnAgent"
      ? Object.fromEntries(item.receiverThreadIds.filter(id => typeof id === "string").map(id => [id, { status: "running" }]))
      : undefined);
    if (!states || typeof states !== "object" || Array.isArray(states)) continue;
    for (const [id, value] of Object.entries(states)) {
      if (!value || typeof value !== "object" || !("status" in value)) continue;
      const state = value.status;
      const status = state === "completed" ? "done" : state === "pendingInit" || state === "running" ? "working" : state === "errored" ? "failed" : state === "interrupted" || state === "shutdown" ? "stopped" : "unknown";
      const message = "message" in value && typeof value.message === "string" ? value.message : undefined;
      const previous = agents.get(id);
      const title = [item.agentTitle, item.title, item.description, item.prompt].find(value => typeof value === "string" && value.trim());
      const pathName = typeof item.agentPath === "string" ? item.agentPath.split("/").filter(Boolean).at(-1)?.replace(/[_-]+/g, " ") : undefined;
      const label = typeof title === "string" ? title.trim().split("\n")[0] : previous?.title || (pathName ? pathName.charAt(0).toUpperCase() + pathName.slice(1) : "Subagent");
      agents.set(id, { id, threadId: id, title: label, status, message });
    }
  }
  return [...agents.values()];
}

export function mergeSessionSubagents(taskAgents: readonly SessionSubagent[] | undefined, codexAgents: readonly SessionSubagent[]): SessionSubagent[] {
  const agents = new Map((taskAgents ?? []).map(agent => [agent.threadId || agent.id, agent]));
  for (const agent of codexAgents) {
    const key=agent.threadId || agent.id;
    const previous=agents.get(key);
    agents.set(key,{...previous,...agent,...(previous?.title && !/^(?:Subagent|Subagent task)$/i.test(previous.title)?{title:previous.title}:{}), ...(agent.status === "unknown" && previous ? { status: previous.status } : {}) });
  }
  return [...agents.values()];
}


/** Persisted ancestry proves membership, not successful completion. */
export function deriveRecordedSubagents(sessions: readonly {threadId:string;title:string;status:string;agentNickname?:string;agentPath?:string;agentStatus?:string;agentUpdatedAt?:string}[]): SessionSubagent[]{
  return sessions.map(session=>{
    const pathName=session.agentPath?.split("/").filter(Boolean).at(-1)?.replace(/[_-]+/g," ");
    const title=!/^(?:New session|New Sofia task|Sofia task|Subagent|Subagent task)$/i.test(session.title) && session.title.trim()?session.title:pathName?pathName.charAt(0).toUpperCase()+pathName.slice(1):session.agentNickname || "Subagent";
    const status=session.agentStatus==="completed"?"done":session.agentStatus==="failed"?"failed":session.agentStatus==="interrupted"?"stopped":session.agentStatus==="working" || session.status==="running"?"working":session.status==="error"?"failed":"unknown";
    return {id:session.threadId,threadId:session.threadId,title,status,...(session.agentUpdatedAt?{updatedAt:session.agentUpdatedAt}:{})};
  });
}
