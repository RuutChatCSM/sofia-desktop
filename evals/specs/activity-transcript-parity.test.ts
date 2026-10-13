import {expect} from "vitest";
import {test} from "@sofia/testkit";
import {parseRolloutItems} from "../../apps/server/src/codex-rollout-items";
import {codexItemToToolParts} from "../../apps/app/src/react-app/domains/session/sync/codex-item-translator";
import {getToolFamily} from "../../apps/app/src/lib/tool-aggregate";

test("a recorded exec wrapper preserves ordered reads, searches, edits, web and command actions",()=>{
  const code='text(await tools.exec_command({cmd:"cat a.ts; sed -n \'1,20p\' b.ts"})); text(await tools.apply_patch("*** Begin Patch\\n*** Update File: a.ts\\n-old\\n+new\\n*** End Patch")); text(await tools.web__run({search_query:[{q:"avatar license"}]})); text(await tools.exec_command({cmd:"pnpm test"}));';
  const items=parseRolloutItems(JSON.stringify({type:"response_item",payload:{type:"custom_tool_call",name:"exec",call_id:"wrapper",input:code}}));
  expect(items).toHaveLength(1);
  const parts=codexItemToToolParts(items[0].item,"session","wrapper",true);
  expect(parts.map(getToolFamily)).toEqual(["read","read","edit","web","command"]);
  expect(new Set(parts.map(part=>part.toolCallId)).size).toBe(5);
  expect(parts[0].input).toMatchObject({filePath:"a.ts"});
  expect(parts[1].input).toMatchObject({filePath:"b.ts"});
  expect(parts[2].input).toMatchObject({filePath:"a.ts",additions:1,deletions:1});
  expect(parts[3].input).toMatchObject({query:"avatar license"});
});

test("restoring richer history repairs old item order and presents compaction without its internal prompt",async()=>{
  const {useCodexSessionStore}=await import("../../apps/app/src/react-app/domains/session/codex-session-store");
  const {restoreCodexSessionItems}=await import("../../apps/app/src/react-app/domains/session/sync/codex-transcript-adapter");
  const {getReactQueryClient}=await import("../../apps/app/src/react-app/infra/query-client");
  const {transcriptKey}=await import("../../apps/app/src/react-app/domains/session/sync/session-sync");
  const store=useCodexSessionStore.getState();
  store.upsertSession({id:"rich-restore",threadId:"rich-restore",title:"Rich",workspaceId:"proof",created:"2026-10-11",status:"idle"});
  store.upsertItem("rich-restore",{id:"command",turnId:"turn",type:"commandExecution",historical:true,item:{id:"command",type:"commandExecution",command:"pnpm test"},text:"",thinking:"",output:"",status:"done"});
  const items=[{turnId:"turn",item:{id:"commentary",type:"agentMessage",phase:"commentary",text:"I will check it."}},{turnId:"turn",item:{id:"compact",type:"contextCompaction",status:"completed"}},{turnId:"turn",item:{id:"command",type:"commandExecution",command:"pnpm test",status:"completed"}},{turnId:"turn",item:{id:"final",type:"agentMessage",phase:"final_answer",text:"Done"}}];
  await restoreCodexSessionItems({items:async()=>({ok:true,items})},"proof","rich-restore");
  expect(useCodexSessionStore.getState().sessions["rich-restore"].items.map(item=>item.id)).toEqual(["commentary","compact","command","final"]);
  const messages=getReactQueryClient().getQueryData(transcriptKey("proof","rich-restore"));
  expect(messages).toEqual(expect.arrayContaining([expect.objectContaining({parts:[expect.objectContaining({toolName:"context_compaction",output:"Context automatically compacted"})]})]));
});

test("recorded patch counts and previews survive turn change projection without borrowing current git state",async()=>{
  const {changeSetFromToolHints}=await import("../../apps/app/src/react-app/domains/session/changes/change-set-from-messages");
  const {changeSetTotals}=await import("../../apps/app/src/react-app/domains/session/changes/turn-change-set");
  const item={type:"dynamicToolCall",id:"patch",tool:"apply_patch",arguments:"*** Begin Patch\n*** Update File: src/example.ts\n-old\n+new\n+second\n*** End Patch",status:"completed"};
  const parts=codexItemToToolParts(item,"session","patch",true);
  const change=changeSetFromToolHints({sessionId:"session",turnId:"turn",startedAt:0,paths:["src/example.ts"],messages:[{id:"patch",role:"assistant",parts},{id:"replay",role:"assistant",parts}]});
  if(!change)throw new Error("Missing change");
  expect(changeSetTotals(change)).toMatchObject({additions:2,deletions:1,countsKnown:true});
  expect(change.repositories[0].files[0].recordedPatch).toContain("-old\n+new");
  expect(change.source).toBe("tool-events");
});

test("full rollout boundaries survive a missing outcome tail and running replay keeps narration before actions",async()=>{
  const {useCodexSessionStore}=await import("../../apps/app/src/react-app/domains/session/codex-session-store");
  const {restoreCodexSessionItems}=await import("../../apps/app/src/react-app/domains/session/sync/codex-transcript-adapter");
  const {getReactQueryClient}=await import("../../apps/app/src/react-app/infra/query-client");
  const {transcriptKey}=await import("../../apps/app/src/react-app/domains/session/sync/session-sync");
  const {deriveTurnPresentation}=await import("../../apps/app/src/components/chat/turn-presentation");
  const {resolveTurnTiming}=await import("../../apps/app/src/components/chat/turn-timing");
  const raw=[
    {timestamp:"2026-10-11T02:31:47.641Z",type:"event_msg",payload:{type:"task_started",turn_id:"turn"}},
    {timestamp:"2026-10-11T02:32:12.016Z",type:"response_item",payload:{type:"message",id:"first",role:"assistant",phase:"commentary",content:[{text:"I will trace the status."}]}},
    {timestamp:"2026-10-11T02:32:13.933Z",type:"response_item",payload:{type:"function_call",call_id:"read",name:"read_file",arguments:'{"path":"SKILL.md"}'}},
    {timestamp:"2026-10-11T02:32:27.867Z",type:"response_item",payload:{type:"message",id:"skill",role:"assistant",phase:"commentary",content:[{text:"I am using the skill."}]}},
    {timestamp:"2026-10-11T08:33:27.435Z",type:"event_msg",payload:{type:"task_complete",turn_id:"turn"}},
  ].map(record=>JSON.stringify(record)).join("\n");
  const items=parseRolloutItems(raw);
  const store=useCodexSessionStore.getState();
  store.upsertSession({id:"live-replay",threadId:"live-replay",title:"Replay",workspaceId:"proof",created:"2026-10-11",status:"running",turnId:"next"});
  store.upsertItem("live-replay",{id:"read",type:"dynamicToolCall",historical:true,turnId:"turn",item:items[1].item,text:"",thinking:"",output:"",status:"done"});
  store.upsertItem("live-replay",{id:"live-tail",type:"agentMessage",turnId:"next",item:{type:"agentMessage",phase:"commentary"},text:"Still working",thinking:"",output:"",status:"pending"});
  await restoreCodexSessionItems({items:async()=>({ok:true,items})},"proof","live-replay");
  expect(useCodexSessionStore.getState().sessions["live-replay"].items.map(item=>item.id)).toEqual(["first","read","skill","live-tail"]);
  const messages=getReactQueryClient().getQueryData<import("ai").UIMessage[]>(transcriptKey("proof","live-replay")) ?? [];
  const restored=messages.slice(0,3);
  expect(deriveTurnPresentation(restored.map((message,index)=>({message,index})),false).answerItems).toEqual([]);
  expect(resolveTurnTiming(restored)).toEqual({startedAt:Date.parse("2026-10-11T02:31:47.641Z"),completedAt:Date.parse("2026-10-11T08:33:27.435Z")});
});

test("adjacent named agent starts form one milestone without crossing commentary",async()=>{
  const {deriveTurnPresentation}=await import("../../apps/app/src/components/chat/turn-presentation");
  const start=(id:string,index:number)=>({index,message:{id,role:"assistant" as const,parts:[{type:"dynamic-tool" as const,toolName:"collaboration.spawn_agent",toolCallId:id,state:"output-available" as const,input:{task_name:id},output:JSON.stringify({task_name:`/root/${id}`})}]}});
  const presentation=deriveTurnPresentation([start("a",0),start("b",1),{index:2,message:{id:"note",role:"assistant",metadata:{engine:{phase:"commentary"}},parts:[{type:"text",text:"Checking"}]}},start("c",3)],true);
  expect(presentation.work.map(entry=>entry.kind)).toEqual(["collaboration","commentary","collaboration"]);
  expect(presentation.work[0]).toMatchObject({parts:[{toolCallId:"a"},{toolCallId:"b"}]});
});

test("a read cannot create an edit card even when a stale artifact path is supplied",async()=>{
 const {changeSetFromToolHints}=await import("../../apps/app/src/react-app/domains/session/changes/change-set-from-messages");
 expect(changeSetFromToolHints({sessionId:"read-only",turnId:"read",startedAt:0,paths:["/skills/SKILL.md"],messages:[{id:"read",role:"assistant",parts:[{type:"dynamic-tool",toolName:"read",toolCallId:"read",state:"output-available",input:{filePath:"/skills/SKILL.md"},output:"instructions"}]}]})).toBeNull();
});

test("recorded diff preview removes transport markers and only uses recorded line coordinates",async()=>{
 const {recordedDiffLines}=await import("../../apps/app/src/react-app/domains/session/changes/recorded-diff-preview");
 const lines=recordedDiffLines("*** Update File: a.ts\n@@ -10,1 +10,2 @@\n-old\n+new\n+second\n*** End Patch\n*** Update File: a.ts\n@@\n context\n*** End Patch");
 expect(lines.map(row=>row.text)).not.toEqual(expect.arrayContaining([expect.stringContaining("***")]));
 expect(lines[1]).toMatchObject({kind:"delete",oldLine:10,newLine:undefined});
 expect(lines[2]).toMatchObject({kind:"add",oldLine:undefined,newLine:10});
 expect(lines.at(-1)).toMatchObject({text:"context",oldLine:undefined,newLine:undefined});
});

test('desktop lifecycle records replace generic calls and retain both named completion milestones',async()=>{
 const {collaborationActivity}=await import('../../apps/app/src/lib/collaboration-activity');
 const raw=[
  {type:'response_item',payload:{type:'function_call',namespace:'collaboration',name:'spawn_agent',call_id:'start',arguments:'{"task_name":"chronology_finish"}'}},
  {type:'event_msg',payload:{type:'item_completed',turn_id:'turn',item:{type:'SubAgentActivity',id:'start',kind:'started',agent_thread_id:'thread',agent_path:'/root/chronology_finish'}}},
  {type:'event_msg',payload:{type:'item_completed',turn_id:'turn',item:{type:'SubAgentActivity',id:'finish',kind:'completed',agent_thread_id:'thread',agent_path:'/root/chronology_finish'}}},
 ].map(value=>JSON.stringify(value)).join('\n');
 const items=parseRolloutItems(raw);
 expect(items).toHaveLength(2);
 const parts=items.flatMap(({item})=>codexItemToToolParts(item,'session','message',true));
 expect(parts.map(part=>collaborationActivity(part).label)).toEqual(['Chronology finish started working','Chronology finish finished']);
 expect(parts.map(part=>collaborationActivity(part).agents[0].id)).toEqual(['thread','thread']);
});

test('recorded reconnect events remain in chronology without inventing missing network history',()=>{
 const items=parseRolloutItems(JSON.stringify({timestamp:'2026-10-11T09:00:00Z',type:'event_msg',payload:{type:'stream_error',turn_id:'turn',message:'Reconnecting… waiting for network'}}));
 expect(items[0].item.type).toBe('networkStatus');
 expect(codexItemToToolParts(items[0].item,'session','network',true)[0].toolName).toBe('network_status');
 expect(parseRolloutItems(JSON.stringify({type:'event_msg',payload:{type:'token_count'}}))).toEqual([]);
});

test('hidden reasoning packets do not split related activity summaries and read icons outrank commands',async()=>{
 const {deriveTurnPresentation}=await import('../../apps/app/src/components/chat/turn-presentation');
 const {getAggregateIconFamily}=await import('../../apps/app/src/lib/tool-aggregate');
 const command=codexItemToToolParts({type:'commandExecution',id:'command',command:'pnpm test',status:'completed'},'session','command',true)[0];
 const read=codexItemToToolParts({type:'commandExecution',id:'read',command:'cat a.ts',commandActions:[{type:'read',path:'a.ts'}],status:'completed'},'session','read',true)[0];
 const messages:import('ai').UIMessage[]=[
 {id:'a',role:'assistant',parts:[command]},
 {id:'b',role:'assistant',parts:[{type:'reasoning',text:'Recorded thought',state:'done'}]},
 {id:'c',role:'assistant',parts:[read]},
 ];
 const presentation=deriveTurnPresentation(messages.map((message,index)=>({message,index})),false);
 expect(presentation.work).toHaveLength(1);
 expect(presentation.work[0]).toMatchObject({kind:'milestone',parts:[command,read]});
 expect(getAggregateIconFamily([command,read])).toBe('read');
});


test("native live lifecycle survives transcript projection with stable task titles and identities", async () => {
 const {collaborationActivity}=await import("../../apps/app/src/lib/collaboration-activity");
 const {useCodexSessionStore}=await import("../../apps/app/src/react-app/domains/session/codex-session-store");
 const {syncCodexTranscriptToCache}=await import("../../apps/app/src/react-app/domains/session/sync/codex-transcript-adapter");
 const {getReactQueryClient}=await import("../../apps/app/src/react-app/infra/query-client");
 const {transcriptKey}=await import("../../apps/app/src/react-app/domains/session/sync/session-sync");
 const store=useCodexSessionStore.getState();
 store.upsertSession({id:"native-lifecycle",threadId:"native-lifecycle",title:"Native",workspaceId:"proof",created:"2026-10-11",status:"running",turnId:"turn"});
 const kinds=["started","interacted","completed","interrupted"];
 for (const kind of kinds) store.upsertItem("native-lifecycle",{id:kind,type:"subAgentActivity",turnId:"turn",item:{id:kind,type:"subAgentActivity",kind,agentThreadId:"child",agentPath:"/root/frontend_architecture"},text:"",thinking:"",output:"",status:"done"});
 syncCodexTranscriptToCache("proof","native-lifecycle");
 const messages=getReactQueryClient().getQueryData<import("ai").UIMessage[]>(transcriptKey("proof","native-lifecycle")) ?? [];
 const activities=messages.flatMap(message=>message.parts).filter((part): part is import("ai").DynamicToolUIPart=>part.type==="dynamic-tool").map(part=>collaborationActivity(part));
 expect(activities.map(activity=>activity.label)).toEqual(["Frontend architecture started working","Sent a message to Frontend architecture","Frontend architecture finished","Frontend architecture interrupted"]);
 expect(activities.map(activity=>activity.agents[0].id)).toEqual(["child","child","child","child"]);
});
