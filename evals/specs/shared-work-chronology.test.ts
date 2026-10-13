import type { UIMessage } from 'ai';
import { expect } from 'vitest';
import { test } from '@sofia/testkit';
import { deriveTurnPresentation } from '../../apps/app/src/components/chat/turn-presentation';
import { codexItemToToolPart } from '../../apps/app/src/react-app/domains/session/sync/codex-item-translator';
import { getCapabilityCallSentence } from '../../apps/app/src/lib/capability-call';
import { getToolFamily } from '../../apps/app/src/lib/tool-aggregate';

const tool = (id:string) => ({type:'dynamic-tool' as const,toolName:'bash',toolCallId:id,state:'output-available' as const,input:{command:'pwd'},output:'workspace'});
test('shared work presentation retains commentary, reasoning and collaboration in recorded chronological order',()=>{
  const collaboration=codexItemToToolPart({id:'collab',type:'collabAgentToolCall',tool:'spawnAgent',status:'completed',prompt:'Inspect transcript',agentsStates:{child:{status:'running'}}},'session','collab',true);
  expect(collaboration).not.toBeNull();
  if(!collaboration)throw new Error('Collaboration marker missing');
  const messages:UIMessage[]=[
    {id:'commentary',role:'assistant',metadata:{engine:{phase:'commentary'}},parts:[{type:'text',text:'Inspecting the recorded source.'}]},
    {id:'before',role:'assistant',parts:[tool('before')]},
    {id:'thinking',role:'assistant',parts:[{type:'reasoning',text:'Check the recovered structure.',state:'done'}]},
    {id:'after',role:'assistant',parts:[tool('after')]},
    {id:'collab',role:'assistant',parts:[collaboration]},
    {id:'final',role:'assistant',metadata:{engine:{phase:'final_answer'}},parts:[{type:'text',text:'Recorded result.'}]},
  ];
  const result=deriveTurnPresentation(messages.map((message,index)=>({message,index})),true);
  expect(result.work.map(entry=>entry.kind)).toEqual(['commentary','milestone','thought','milestone','collaboration']);
  expect(result.work.filter(entry=>entry.kind==='milestone').map(entry=>entry.parts.map(part=>part.toolCallId))).toEqual([['before'],['after']]);
  expect(result.answerItems.map(entry=>entry.message.id)).toEqual(['final']);
  expect(getCapabilityCallSentence(collaboration).past).toBe('Started an agent · 1 working');
});
test('agent operations use explicit tool identity and recorded status without claiming child completion',()=>{
  expect(getCapabilityCallSentence({...tool('send'),toolName:'send_message'}).past).toBe('Sent a message to an agent');
  const collaboration=codexItemToToolPart({id:'wait',type:'collabAgentToolCall',tool:'wait',status:'completed',agentsStates:{one:{status:'completed'},two:{status:'errored'}}},'session','wait',true);
  if(!collaboration)throw new Error('Collaboration marker missing');
  expect(getCapabilityCallSentence(collaboration).past).toBe('Waited for agents · 1 done, 1 failed');
});
test('command activity uses explicit parsed read/search actions while unknown shell work remains a command',()=>{
  for(const [action,family] of [[{type:'read',path:'/workspace/source.ts'},'read'],[{type:'search',query:'needle',path:'/workspace'},'search'],[{type:'unknown'},'command']] as const){
    const part=codexItemToToolPart({id:'command',type:'commandExecution',status:'completed',command:'recorded command',commandActions:[action]},'session','command',true);
    if(!part)throw new Error('Command marker missing');
    expect(getToolFamily(part)).toBe(family);
  }
});
