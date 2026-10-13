import { avoidSessionSummary } from "../../apps/app/src/react-app/domains/session/panel/session-summary-layout";
import { codexItemToToolPart } from "../../apps/app/src/react-app/domains/session/sync/codex-item-translator";
import { workspaceFilePath } from "../../apps/app/src/react-app/domains/session/artifacts/workspace-file-path";
import type { UIMessage } from "ai";
import { expect } from "vitest";
import { test } from "@sofia/testkit";
import { deriveSessionResources } from "../../apps/app/src/react-app/domains/session/panel/session-resources";
import { useSessionResourcesStore } from "../../apps/app/src/react-app/domains/session/panel/session-resources-store";

test("sources retain user attachments without internal files read by the agent", () => {
  const input: UIMessage = {id:'input',role:'user',parts:[{type:'file',filename:'Pasted text.txt',mediaType:'text/plain',url:'file:///workspace/UUID-Pasted%20text.txt'}]};
  const reply: UIMessage = {id:'reply',role:'assistant',parts:[
    {type:'dynamic-tool',toolName:'read',toolCallId:'read',state:'output-available',input:{filePath:'/workspace/UUID-Pasted text.txt'},output:'read'},
    {type:'dynamic-tool',toolName:'read',toolCallId:'read-other',state:'output-available',input:{filePath:'/workspace/Research.md'},output:'notes'},
    {type:'dynamic-tool',toolName:'write',toolCallId:'write',state:'output-available',input:{filePath:'/workspace/Report.md',content:'report'},output:'written'},
  ]};
  const resources=deriveSessionResources([input,reply]);
  expect(resources.sources.map(source=>source.label)).toEqual(['Pasted text.txt']);
  expect(resources.outputs.map(output=>output.name)).toEqual(['Report.md']);
  expect(resources.outputs[0].path).toBe('/workspace/Report.md');
});

test("external references deduplicate and reject executable URLs without inventing document paths", () => {
  const message: UIMessage={id:'references',role:'assistant',parts:[
    {type:'source-url',sourceId:'one',url:'https://example.com/research',title:'Research'},
    {type:'source-url',sourceId:'duplicate',url:'https://example.com/research',title:'Same page'},
    {type:'source-url',sourceId:'unsafe',url:'javascript:alert(1)'},
    {type:'source-document',sourceId:'doc',mediaType:'application/pdf',title:'Attached report'},
  ]};
  const resources=deriveSessionResources([message]);
  expect(resources.sources).toEqual([{id:'url:https://example.com/research',kind:'url',label:'Research',value:'https://example.com/research'},{id:'document:doc',kind:'document',label:'Attached report',mediaType:'application/pdf'}]);
  expect(resources.outputs).toEqual([]);
});

test("resources remain scoped to their own session and update without another session leaking",()=>{
  const a=deriveSessionResources([{id:'a',role:'user',parts:[{type:'file',url:'file:///workspace/a.txt',filename:'a.txt',mediaType:'text/plain'}]}]);
  const b=deriveSessionResources([{id:'b',role:'user',parts:[{type:'file',url:'file:///workspace/b.txt',filename:'b.txt',mediaType:'text/plain'}]}]);
  const store=useSessionResourcesStore.getState();store.setSession('a',a);store.setSession('b',b);
  expect(useSessionResourcesStore.getState().sessions.a.sources[0].label).toBe('a.txt');
  store.setSession('a',{outputs:[],sources:[],subagents:[]});
  expect(useSessionResourcesStore.getState().sessions.b.sources[0].label).toBe('b.txt');
});


test("artifact API paths retain case and only strip the exact workspace prefix",()=>{
  expect(workspaceFilePath('/workspace','/workspace/Report.md')).toBe('Report.md');
  expect(workspaceFilePath('/workspace','/workspace-other/Report.md')).toBe('/workspace-other/Report.md');
  expect(workspaceFilePath('/workspace','../secret.txt')).toBe('../secret.txt');
  expect(workspaceFilePath('/workspace','Report.md')).toBe('Report.md');
});


test("MCP integration sources retain server identity even when the tool renders as a read",()=>{
  const resources=deriveSessionResources([{id:'mcp',role:'assistant',parts:[{type:'dynamic-tool',toolName:'read',toolCallId:'call',state:'output-available',input:{arguments:'{}'},output:'observed',callProviderMetadata:{engine:{codexItemType:'mcpToolCall',codexToolServer:'calendar',codexToolName:'list_events'}}}]}]);
  expect(resources.sources).toEqual([{id:'tool:calendar',kind:'tool',label:'calendar'}]);
  expect(resources.outputs).toEqual([]);
});


test("recorded web search becomes a completed activity and one Sources marker",()=>{
  const part=codexItemToToolPart({id:'web-one',type:'webSearch',status:'completed',action:{type:'search',query:'fixture'}},'session','web-message',true);
  if(!part)throw new Error('Web search was dropped');
  expect(part.state).toBe('output-available');
  const resources=deriveSessionResources([{id:'search',role:'assistant',parts:[part]}]);
  expect(resources.sources).toEqual([{id:'web-search',kind:'web',label:'Web search'}]);
});


test("compact Sources preserve shipped file, external, tool, web ordering",()=>{
  const web=codexItemToToolPart({id:'web',type:'webSearch',status:'completed'},'session','web',true);
  if(!web)throw new Error('Expected web item');
  const resources=deriveSessionResources([{id:'ordering',role:'assistant',parts:[web,
    {type:'dynamic-tool',toolName:'calendar',toolCallId:'mcp',state:'output-available',input:{},output:'ok',callProviderMetadata:{engine:{codexItemType:'mcpToolCall'}}},
    {type:'source-url',sourceId:'url',url:'https://example.com'},
    {type:'dynamic-tool',toolName:'read',toolCallId:'read',state:'output-available',input:{filePath:'/workspace/notes.md'},output:'notes'},
  ]}]);
  expect(resources.sources.map(source=>source.kind)).toEqual(['url','tool','web']);
});


test("default live preview clears the summary card while retaining its right-side lane",()=>{
  const point={x:1056,y:24},size={width:200,height:150},host={width:1280,height:900};
  expect(avoidSessionSummary(point,size,host,[])).toEqual(point);
  expect(avoidSessionSummary(point,size,host,[{x:960,y:20,width:300,height:320}])).toEqual({x:1056,y:352});
});

test("Sources shows newest user screenshots before older attachments and excludes internal reads",()=>{
  const resources=deriveSessionResources([
    {id:"old",role:"user",parts:[{type:"file",url:"file:///tmp/old.png",filename:"old.png",mediaType:"image/png"}]},
    {id:"internal",role:"assistant",parts:[{type:"dynamic-tool",toolName:"read",toolCallId:"read",state:"output-available",input:{filePath:"/skills/SKILL.md"},output:"instructions"}]},
    {id:"new",role:"user",parts:[{type:"file",url:"file:///tmp/new.png",filename:"new.png",mediaType:"image/png"}]},
  ]);
  expect(resources.sources.map(source=>source.label)).toEqual(["new.png","old.png"]);
});

test('project modifications stay out of Outputs while produced reports remain collectible',()=>{
 const resources=deriveSessionResources([{id:'work',role:'assistant',parts:[
 {type:'dynamic-tool',toolName:'apply_patch',toolCallId:'edit',state:'output-available',input:{filePath:'src/example.ts',patch:'+new'},output:''},
 {type:'dynamic-tool',toolName:'write',toolCallId:'report',state:'output-available',input:{filePath:'Report.md',content:'report'},output:''},
 ]}]);
 expect(resources.outputs.map(output=>output.name)).toEqual(['Report.md']);
});
