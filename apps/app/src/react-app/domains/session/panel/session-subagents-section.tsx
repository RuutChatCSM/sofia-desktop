import { AgentAvatar } from "./agent-avatar";
import { summarizeSessionSubagents, type SessionSubagent } from "./session-subagents";

/** The native aggregate opens a dedicated subagent overview pane. */
export function SessionSubagentsSection({ agents, onOpen }: { agents: readonly SessionSubagent[]; onOpen: () => void }) {
  if (!agents.length) return null;
  const summary = summarizeSessionSubagents(agents);
  const settled=summary.done;
  return <div data-session-subagents="" className="border-t border-current/10 pt-3">
    <h2 className="mb-3">Subagents</h2>
    <button type="button" aria-label="Open subagents" onClick={onOpen} className="flex w-full items-center gap-2 text-left">
      <span className="flex gap-1" aria-hidden="true">{summary.avatars.map(agent => <AgentAvatar key={agent.id} id={agent.threadId || agent.id} className="size-4" />)}</span>
      <span className="whitespace-nowrap">{summary.working?`${summary.working} working`:settled?`${settled} done`:"View agents"}</span>
      {summary.working && settled ? <span className="ms-auto whitespace-nowrap opacity-70">{settled} done</span> : null}
    </button>
  </div>;
}
