import { mkdtemp,rm } from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {expect,onTestFinished} from "vitest";
import {control,createAndSelectWorkspace,evalIn} from "@sofia/behaviors";
import {desktop} from "@sofia/hosts";
import {eventually,needs,test} from "@sofia/testkit";

test("sidebar keeps root conversations and old child URLs return to their parent",{timeout:180_000},async()=>{
  needs({optIn:["SOFIA_EVAL_E2E_TESTS"],placement:"local"});
  const path=await mkdtemp(join(tmpdir(),"sofia-parent-list-"));onTestFinished(()=>rm(path,{recursive:true,force:true}));
  await using app=await desktop({name:"session-list-parent"});
  await createAndSelectWorkspace(app,{path});await control(app,"session.create_task");
  await app.client.send("Input.dispatchKeyEvent",{type:"keyDown",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});
  await app.client.send("Input.dispatchKeyEvent",{type:"keyUp",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});
  await eventually(async()=>{expect(await evalIn(app,`Boolean(document.querySelector('[data-session-surface-id]'))`)).toBe(true);return true;},{within:10000});
  const root=await evalIn(app,`(async()=>{
    const {useCodexSessionStore}=await import('/src/react-app/domains/session/codex-session-store.ts');
    const id=document.querySelector('[data-session-surface-id]').getAttribute('data-session-surface-id');
    const session=useCodexSessionStore.getState().sessions[id].session;
    useCodexSessionStore.getState().upsertSession({...session,title:'Install the rea skill'});
    useCodexSessionStore.getState().upsertSession({...session,id:'codex-visible-child',threadId:'visible-child',parentSessionId:id,title:'Child research'});
    const original=window.fetch.bind(window);
    window.fetch=async(input,init)=>{
      const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;
      if(url.endsWith('/codex/sessions/'+encodeURIComponent(id)+'/items'))return new Response(JSON.stringify({ok:true,items:[],subagentSessions:[{...session,id:'codex-visible-child',threadId:'visible-child',parentSessionId:id,title:'Child research',agentNickname:'Research worker',status:'idle'}]}));
      if(url.includes('/subagents/visible-child/items'))return new Response(JSON.stringify({ok:true,items:[{turnId:'child',item:{id:'env',type:'userMessage',content:[{type:'text',text:'<environment_context>INTERNAL CHILD ENVIRONMENT</environment_context>'}]}},{turnId:'child',item:{id:'commentary',type:'agentMessage',phase:'commentary',text:'Inspecting child files',turnStartedAt:1000,turnCompletedAt:11000}},{turnId:'child',item:{id:'command',type:'commandExecution',command:'ls',aggregatedOutput:'source.ts',status:'completed',turnStartedAt:1000,turnCompletedAt:11000}},{turnId:'child',item:{id:'answer',type:'agentMessage',phase:'final_answer',text:'Recorded nested worker result',turnStartedAt:1000,turnCompletedAt:11000}}]}));
      if(url.endsWith('/codex/sessions/codex-old-child/items'))return new Response(JSON.stringify({ok:true,parentSessionId:id,items:[]}));
      return original(input,init);
    };
    const {restoreCodexSessionItems}=await import('/src/react-app/domains/session/sync/codex-transcript-adapter.ts');
    await restoreCodexSessionItems({items:async()=>({ok:true,items:[],subagentSessions:[{...session,id:'codex-visible-child',threadId:'visible-child',parentSessionId:id,title:'Child research',agentNickname:'Research worker',status:'idle'}]})},session.workspaceId,id);
    return {id,path:window.location.hash.replace(id,'codex-visible-child')};
  })()`,{awaitPromise:true});
  await eventually(async()=>{expect(await evalIn(app,`document.querySelector('h1').textContent`)).toBe('Install the rea skill');return true;},{within:5000});
  expect(await evalIn(app,`document.querySelector('[data-session-tab-id="codex-visible-child"]')===null`)).toBe(true);
  await evalIn(app,`window.location.hash=${JSON.stringify(root.path)}`);
  await eventually(async()=>{expect(await evalIn(app,`document.querySelector('[data-session-surface-id]').getAttribute('data-session-surface-id')`)).toBe(root.id);return true;},{within:10000});
  await evalIn(app,`window.location.hash=${JSON.stringify(root.path.replace('codex-visible-child','codex-old-child'))}`);
  await eventually(async()=>{expect(await evalIn(app,`document.querySelector('[data-session-surface-id]').getAttribute('data-session-surface-id')`)).toBe(root.id);return true;},{within:10000});
  await evalIn(app,`(async()=>{const {useCodexSessionStore}=await import('/src/react-app/domains/session/codex-session-store.ts'); const id=document.querySelector('[data-session-surface-id]').getAttribute('data-session-surface-id');const state=useCodexSessionStore.getState();state.upsertSession({...state.sessions[id].session,title:'Install the rea skill'});})()`,{awaitPromise:true});
  await eventually(async()=>{expect(await evalIn(app,`document.querySelector('h1').textContent`)).toBe('Install the rea skill');return true;},{within:5000});
  expect(await evalIn(app,`document.querySelector('[data-session-tab-id="codex-visible-child"]')===null`)).toBe(true);
  await evalIn(app,`if(!document.querySelector('[data-session-subagents]'))document.querySelector('button[aria-label="Outputs and Sources"]').click()`);
  await eventually(async()=>{expect(await evalIn(app,`document.querySelector('[data-session-subagents]')?.textContent ?? document.body.innerText`)).toContain('View agents');return true;},{within:5000});
  await evalIn(app,`document.querySelector('button[aria-label="Open subagents"]').click()`);
  await eventually(async()=>{expect(await evalIn(app,`document.querySelector('[data-session-subagent-details]').textContent`)).toContain('Child research');return true;},{within:5000});
  await evalIn(app,`document.querySelector('button[aria-label="Open conversation: Child research"]').click()`);
  await eventually(async()=>{expect(await evalIn(app,`document.querySelector('[data-subagent-conversation]').textContent`)).toContain('Recorded nested worker result');return true;},{within:5000});
  expect(await evalIn(app,`document.querySelector('[data-subagent-conversation]').textContent`)).not.toContain('INTERNAL CHILD ENVIRONMENT');
  expect(await evalIn(app,`document.querySelector('[data-subagent-conversation]').textContent`)).toContain('Worked for 10s');
  await evalIn(app,`Array.from(document.querySelectorAll('[data-subagent-conversation] button')).find(button=>button.textContent.includes('Worked for 10s')).click()`);
  await eventually(async()=>{expect(await evalIn(app,`document.querySelector('[data-subagent-conversation]').textContent`)).toContain('Inspecting child files');return true;},{within:5000});
  expect(await evalIn(app,`document.querySelector('[data-subagent-conversation]').textContent`)).toContain('Ran a command');
  expect(await evalIn(app,`document.querySelector('[data-subagent-conversation] button[aria-label="Revert"]')===null`)).toBe(true);
  await evalIn(app,`document.querySelector('button[aria-label="Back to subagents"]').click()`);
  await evalIn(app,`(async()=>{
    const {useCodexSessionStore}=await import('/src/react-app/domains/session/codex-session-store.ts');
    const id=document.querySelector('[data-session-surface-id]').getAttribute('data-session-surface-id');
    const entry=useCodexSessionStore.getState().sessions[id];
    const template=entry.subagentSessions[0];
    const children=Array.from({length:17},(_,i)=>({...template,id:'codex-agent-'+i,threadId:'agent-'+i,title:'Agent '+i,agentNickname:'Worker '+i,agentStatus:i<12?'completed':'working',agentUpdatedAt:new Date(Date.now()-60000).toISOString()}));
    useCodexSessionStore.setState(state=>({sessions:{...state.sessions,[id]:{...entry,subagentSessions:children}}}));
  })()`,{awaitPromise:true});
  await eventually(async()=>{expect(await evalIn(app,`document.querySelector('[data-subagent-group="done"] h2').textContent`)).toBe('Done · 12');return true;},{within:5000});
  expect(await evalIn(app,`document.querySelectorAll('[data-subagent-group="done"] [data-subagent-id]').length`)).toBe(10);
  expect(await evalIn(app,`document.querySelectorAll('[data-subagent-group="active"] [data-subagent-id]').length`)).toBe(4);
  expect(await evalIn(app,`document.querySelector('[data-subagent-group="done"]').textContent`)).toContain('1m ago');
  await evalIn(app,`Array.from(document.querySelectorAll('[data-subagent-group="done"] button')).find(button=>button.textContent==='Show 2 more').click()`);
  expect(await evalIn(app,`document.querySelectorAll('[data-subagent-group="done"] [data-subagent-id]').length`)).toBe(12);

  await evalIn(app,`(()=>{const previous=window.fetch;window.__childPollReads=0;window.fetch=async(input,init)=>{const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;if(url.includes('/subagents/agent-12/items')){window.__childPollReads++;return new Response(JSON.stringify({ok:true,items:[{turnId:'active-child',item:{id:'active-result',type:'agentMessage',text:'Working child update '+window.__childPollReads}}]}));}return previous(input,init);};})()`);
  await evalIn(app,`document.querySelector('button[aria-label="Open conversation: Agent 12"]').click()`);
  await eventually(async()=>{expect(await evalIn(app,`document.querySelector('[data-subagent-conversation]').textContent`)).toContain('Working child update 1');return true;},{within:5000});
  await eventually(async()=>{expect(await evalIn(app,`document.querySelector('[data-subagent-conversation]').textContent`)).toContain('Working child update 2');return true;},{within:7000});

});
