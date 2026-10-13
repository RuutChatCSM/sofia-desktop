import type { DynamicToolUIPart } from 'ai';

function isRecord(value: unknown): value is Record<string, unknown> {
 return !!value && typeof value==='object' && !Array.isArray(value);
}
function record(value: unknown): Record<string, unknown> | null {
 if(typeof value==='string'){try{return record(JSON.parse(value));}catch{return null;}}
 return isRecord(value) ? value : null;
}
export function isCollaborationActivity(part: DynamicToolUIPart): boolean {
 return part.toolName==='collaboration' || /^(?:collaboration\.)?(?:spawn_agent|spawnAgent|send_message|sendInput|wait|wait_agent|close_agent|closeAgent|interrupt_agent|followup_task|list_agents)$/.test(part.toolName);
}
export function collaborationActivity(part: DynamicToolUIPart, names: ReadonlyMap<string,string> = new Map(), identities: ReadonlyMap<string,string> = new Map()) {
 const envelope=record(part.input);
 const input=record(envelope?.arguments) ?? envelope;
 const operation=typeof input?.operation==='string'?input.operation:part.toolName.split('.').at(-1) || '';
 const rawOutput=record('output' in part?part.output:undefined);
 const content=rawOutput?.content;
 const output=Array.isArray(content)?content.map(value=>record(record(value)?.text)).find(value=>value?.agent_id || value?.threadId || value?.agentsStates || value?.task_name) ?? rawOutput:rawOutput;
 const ids=new Set<string>();
 const states=record(input?.agentsStates) ?? record(output?.agentsStates);
 if(states)for(const id of Object.keys(states))ids.add(identities.get(id) || id);
 for(const value of [input?.receiverThreadIds,input?.ids])if(Array.isArray(value))for(const id of value)if(typeof id==='string')ids.add(identities.get(id) || id);
 for(const value of [output?.agent_id,output?.threadId,output?.task_name,input?.id,input?.target])if(typeof value==='string')ids.add(identities.get(value) || value);
 const humanize=(value:string)=>{const name=value.split('/').filter(Boolean).at(-1)?.replace(/[_-]+/g,' ') || value;return name.charAt(0).toUpperCase()+name.slice(1);};
 const requestedName=typeof input?.task_name==='string'?humanize(input.task_name):undefined;
 const agentPath=typeof input?.agentPath==='string'?input.agentPath:undefined;
 const resolve=(id:string)=>identities.get(id) || [...identities].find(([path])=>path.split('/').at(-1)===id)?.[1] || id;
 const agents=[...ids].map(resolve).map(id=>({id,name:names.get(id) || requestedName || (agentPath?humanize(agentPath):undefined) || (id.startsWith('/root/')?humanize(id):'Subagent'),status:record(states?.[id] ?? Object.entries(states ?? {}).find(([key])=>identities.get(key)===id)?.[1])?.status}));
 const labels=agents.map(agent=>agent.name).join(' and ') || requestedName || 'an agent';
 const running=part.state==='input-available' || part.state==='input-streaming';
 const failed=part.state==='output-error' || part.state==='output-denied';
 const spawn=/spawn/i.test(operation);
 const send=/send|followup/i.test(operation);
 const completed=agents.length>0 && agents.every(agent=>agent.status==='completed');
 const interrupted=agents.length>0 && agents.every(agent=>agent.status==='interrupted');
 const suffix=failed?' failed':spawn?(running?' starting':' started working'):completed?' finished':running?' waiting':' status updated';
 const label=interrupted?`${labels} interrupted`:send?`${running?'Sending':'Sent'} a message to ${labels}`:spawn || completed?`${labels}${suffix}`:`${running?'Waiting for':'Checked'} ${labels}${failed?' · failed':''}`;
 return {agents,label,message:send};
}
