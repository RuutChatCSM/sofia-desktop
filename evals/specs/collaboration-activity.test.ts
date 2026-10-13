import {expect} from 'vitest';
import {test} from '@sofia/testkit';
import type {DynamicToolUIPart} from 'ai';
import {collaborationActivity,isCollaborationActivity} from '../../apps/app/src/lib/collaboration-activity';
const part=(input:unknown):DynamicToolUIPart=>({type:'dynamic-tool',toolName:'collaboration',toolCallId:'activity',state:'output-available',input,output:''});
test('named collaboration marks retain thread identities and require explicit completion evidence',()=>{
 const names=new Map([['one','Research'],['two','Review']]);
 const started=collaborationActivity(part({operation:'spawnAgent',agentsStates:{one:{status:'running'},two:{status:'running'}}}),names);
 expect(started.label).toBe('Research and Review started working');
 expect(started.agents.map(agent=>agent.id)).toEqual(['one','two']);
 expect(collaborationActivity(part({operation:'wait',agentsStates:{one:{status:'completed'}}}),names).label).toBe('Research finished');
 expect(collaborationActivity(part({operation:'wait',receiverThreadIds:['one']}),names).label).toBe('Checked Research');
 expect(collaborationActivity(part({operation:'sendInput',receiverThreadIds:['one']}),names).label).toBe('Sent a message to Research');
 const raw:DynamicToolUIPart={...part({task_name:'Research_worker'}),toolName:'collaboration.spawn_agent',output:'{"agent_id":"one"}'};
 expect(isCollaborationActivity(raw)).toBe(true);
 expect(collaborationActivity(raw,names).agents[0]?.id).toBe('one');
});

test('desktop task path outputs resolve avatars to recorded thread identity through legacy argument envelopes',()=>{
 const names=new Map([['thread','Subagent view parity']]);
 const identities=new Map([['/root/subagent_view_parity','thread']]);
 const started=collaborationActivity({...part({arguments:JSON.stringify({task_name:'subagent_view_parity'})}),toolName:'collaboration.spawn_agent',output:JSON.stringify({task_name:'/root/subagent_view_parity'})},names,identities);
 expect(started.agents.map(agent=>agent.id)).toEqual(['thread']);
 expect(started.label).toBe('Subagent view parity started working');
 expect(collaborationActivity({...part({arguments:{target:'/root/subagent_view_parity'}}),toolName:'collaboration.send_message'},names,identities).label).toBe('Sent a message to Subagent view parity');
});
