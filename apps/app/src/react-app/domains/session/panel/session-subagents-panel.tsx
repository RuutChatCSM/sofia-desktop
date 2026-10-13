import { useEffect, useMemo, useRef, useState } from "react";
import { subagentHistoryMessages, type SubagentHistoryItem } from "./subagent-history";
import { SubagentRunLine } from "@/components/chat/subagent-run-line";
import { MessageList } from "@/components/chat/message-list";
import { MessageListProvider } from "@/components/chat/message-list-provider";
import type { SofiaServerClient } from "@/app/lib/sofia-server";
import { AgentAvatar } from "./agent-avatar";
import type { SessionSubagent } from "./session-subagents";

const statusLabels: Record<SessionSubagent["status"], string> = {working:"Working…",done:"Completed",failed:"Failed",stopped:"Stopped",unknown:"Status unknown"};
const noop=()=>{};
const unavailable=async()=>{throw new Error("Recorded subagent conversations are read-only.");};
export function relativeAgentTime(value: string | undefined, now=Date.now()):string|null {
  if(!value)return null;
  const elapsed=now-Date.parse(value);
  if(!Number.isFinite(elapsed))return null;
  const minutes=Math.max(0,Math.floor(elapsed/60000));
  return minutes<1?"Just now":minutes<60?`${minutes}m ago`:minutes<1440?`${Math.floor(minutes/60)}h ago`:`${Math.floor(minutes/1440)}d ago`;
}
export function SessionSubagentsPanel({ agents, loadHistory, workspaceId="", client=null }: { agents: readonly SessionSubagent[]; loadHistory?: (threadId: string) => Promise<SubagentHistoryItem[]>;workspaceId?:string;client?:SofiaServerClient|null }) {
  const [selectedTask,setSelectedTask]=useState<string|null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const previousSelection=useRef<string|null>(null);
  const [history, setHistory] = useState<SubagentHistoryItem[]>([]);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded,setExpanded]=useState<Set<string>>(()=>new Set());
  useEffect(() => {
    if (!selected || !loadHistory) return;
    let cancelled = false;
    const changed=previousSelection.current!==selected;
    previousSelection.current=selected;
    if(changed){setLoading(true);setHistory([]);}
    setError(null);
    void loadHistory(selected).then(items => { if (!cancelled) setHistory(items); }, failure => { if (!cancelled) setError(failure instanceof Error ? failure.message : "Could not load this conversation"); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [selected, loadHistory, revision]);
  const messages=useMemo(()=>subagentHistoryMessages(history,selected ?? ""),[history,selected]);
  const agent=agents.find(candidate=>candidate.threadId===selected);
  useEffect(()=>{if(!selected||agent?.status!=="working")return;const timer=setInterval(()=>setRevision(value=>value+1),3000);return()=>clearInterval(timer);},[selected,agent?.status]);
  if (selected) return <section data-subagent-conversation="" className="flex h-full flex-col text-sm">
    <header className="flex min-h-12 shrink-0 items-center gap-3 border-b border-border px-5">
      <button type="button" aria-label="Back to subagents" onClick={() => setSelected(null)} className="text-muted-foreground">←</button>
      <AgentAvatar id={selected}/><h2 className="truncate">{agent?.title || "Subagent"}</h2><span className="text-xs text-muted-foreground">{statusLabels[agent?.status ?? "unknown"]}</span>
      <button type="button" disabled={loading} onClick={() => setRevision(value => value + 1)} className="ml-auto text-xs text-muted-foreground">Refresh conversation</button>
    </header>
    <div className="min-h-0 flex-1 overflow-auto py-6">
    {error?<p role="alert" className="px-5">{error}</p>:null}
    {loading ? <p role="status" className="px-5">Loading conversation…</p> : !messages.length ? <p className="px-5 text-muted-foreground">No recorded conversation yet.</p> : <MessageListProvider workspaceId={workspaceId} workspaceRoot="" mediaClient={client} sessionId={selected} showThinking readOnly developerMode={false} displaySuggestions={false} providerConnectedCount={0} dispatchAction={noop} setPrompt={noop} onRevertToUserMessage={noop} onForkAtMessage={noop} onEditUserMessage={noop} onMcpReconnect={unavailable} onMcpReopenAuthorization={unavailable} onMcpRetry={unavailable}><MessageList messages={messages} status="ready"/></MessageListProvider>}
    </div>
  </section>;
  const groups=[{id:"active",label:"Active",items:agents.filter(agent=>agent.status==="working"),limit:4},{id:"done",label:"Done",items:agents.filter(agent=>agent.status==="done"),limit:10},{id:"attention",label:"Failed or stopped",items:agents.filter(agent=>agent.status==="failed"||agent.status==="stopped"),limit:10},{id:"other",label:"Other recorded agents",items:agents.filter(agent=>agent.status==="unknown"),limit:10}];
  return <section data-session-subagent-details="" className="h-full overflow-auto px-5 py-6 text-sm"><div className="mx-auto max-w-[800px]">
    {selectedTask?agents.filter(agent=>agent.id===selectedTask&&agent.part).map(agent=><div key={agent.id} className="mb-6"><button className="mb-3 text-muted-foreground" onClick={()=>setSelectedTask(null)}>← All subagents</button>{agent.part?<SubagentRunLine part={agent.part}/>:null}</div>):null}
    {groups.map(group=>group.id==="other"&&!group.items.length?null:<section key={group.id} data-subagent-group={group.id} className="mb-6">
      <h2 className="mb-3 text-muted-foreground">{group.label} · {group.items.length}</h2>
      {!group.items.length&&group.id==="active"?<p className="text-muted-foreground">No active subagents</p>:null}
      {group.items.slice(0,expanded.has(group.id)?undefined:group.limit).map(agent=><button key={agent.id} data-subagent-id={agent.id} type="button" disabled={(!agent.threadId||!loadHistory)&&!agent.part} onClick={()=>agent.threadId&&loadHistory?setSelected(agent.threadId):setSelectedTask(agent.id)} aria-label={`Open conversation: ${agent.title}`} className="flex w-full items-center gap-3 rounded-lg px-1 py-3 text-left hover:bg-muted/40 disabled:opacity-100">
        <AgentAvatar id={agent.threadId||agent.id} className="size-6 shrink-0"/>
        <span className="min-w-0 flex-1 truncate">{agent.title}</span>
        <span className="shrink-0 text-xs text-muted-foreground">{agent.status==="done"?relativeAgentTime(agent.updatedAt):statusLabels[agent.status]}</span>
      </button>)}
      {group.items.length>group.limit&&!expanded.has(group.id)?<button type="button" onClick={()=>setExpanded(value=>new Set([...value,group.id]))} className="ml-10 mt-2 text-muted-foreground">Show {group.items.length-group.limit} more</button>:null}
    </section>)}
  </div></section>;
}
