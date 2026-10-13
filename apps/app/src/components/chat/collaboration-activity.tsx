import type { DynamicToolUIPart } from 'ai';
import { MessageCircle, Users } from 'lucide-react';
import { collaborationActivity } from '@/lib/collaboration-activity';
import { useCodexSessionStore } from '@/react-app/domains/session/codex-session-store';
import { AgentAvatar } from '@/react-app/domains/session/panel/agent-avatar';
import { deriveRecordedSubagents } from '@/react-app/domains/session/panel/session-subagents';

export function CollaborationActivity({part,parts}:{part:DynamicToolUIPart;parts?:DynamicToolUIPart[]}) {
 const sessions=useCodexSessionStore(state=>state.sessions);
 const names=new Map<string,string>();
 const identities=new Map<string,string>();
 for(const entry of Object.values(sessions))for(const agent of deriveRecordedSubagents(entry.subagentSessions ?? []))names.set(agent.id,agent.title);
 for(const entry of Object.values(sessions))for(const agent of entry.subagentSessions ?? [])if(agent.agentPath)identities.set(agent.agentPath,agent.threadId);
 const activity=collaborationActivity(part,names,identities);
 const activities=(parts ?? [part]).map(value=>collaborationActivity(value,names,identities));
 const agents=activities.flatMap(value=>value.agents).filter((agent,index,all)=>all.findIndex(value=>value.id===agent.id)===index);
 const label=activities.length>1?`${agents.map(agent=>agent.name).join(" and ")} started working`:activity.label;
 return <div data-collaboration-activity={part.toolCallId} className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
  {activity.message && !agents.length?<MessageCircle aria-hidden="true" className="size-4 shrink-0"/>:agents.length?agents.slice(0,4).map(agent=><AgentAvatar key={agent.id} id={agent.id} className="size-4"/>):<Users aria-hidden="true" className="size-4 shrink-0"/>}
  <span className="min-w-0">{label}</span>
 </div>;
}
