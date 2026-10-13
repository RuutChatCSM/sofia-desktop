import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, onTestFinished } from "vitest";
import { control, createAndSelectWorkspace, evalIn } from "@sofia/behaviors";
import { desktop } from "@sofia/hosts";
import { eventually, needs, test } from "@sofia/testkit";
import { parseDurableTurnOutcomes } from "../../apps/server/src/codex-turn-outcomes";
import { parseRolloutItems } from "../../apps/server/src/codex-rollout-items";

test("imported rollout renders its title, image, timed narrative and named tool in the shared session view", { timeout: 180_000 }, async () => {
  needs({optIn:["SOFIA_EVAL_E2E_TESTS"],placement:"local"});
  const path=await mkdtemp(join(tmpdir(),"sofia-import-presentation-"));
  onTestFinished(()=>rm(path,{recursive:true,force:true}));
  const record=(payload:object,timestamp="2026-10-11T00:00:00Z",type="response_item")=>JSON.stringify({type,timestamp,payload});
  const image="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=";
  const raw=[
    record({type:"task_started",turn_id:"fixture-import-turn"},undefined,"event_msg"),
    record({turn_id:"fixture-import-turn"},undefined,"turn_context"),
    record({type:"message",role:"user",content:[{type:"input_text",text:"# Files mentioned by the user:\n\n## Screenshot.png: /tmp/Screenshot.png\nImage attachment: true\n\n## My request:\nInspect this screenshot"},{type:"input_image",image_url:image}]}),
    record({type:"message",role:"assistant",phase:"commentary",content:[{type:"output_text",text:"I will inspect the actual implementation."}]}),
    record({type:"item_completed",turn_id:"fixture-import-turn",item:{type:"SubAgentActivity",id:"agent-start-one",kind:"started",agent_thread_id:"one",agent_path:"/root/chronology_finish"}},undefined,"event_msg"),
    record({type:"item_completed",turn_id:"fixture-import-turn",item:{type:"SubAgentActivity",id:"agent-start-two",kind:"started",agent_thread_id:"two",agent_path:"/root/identity_finish"}},undefined,"event_msg"),
    record({type:"item_completed",turn_id:"fixture-import-turn",item:{type:"SubAgentActivity",id:"agent-done",kind:"completed",agent_thread_id:"two",agent_path:"/root/identity_finish"}},undefined,"event_msg"),
    record({type:"stream_error",turn_id:"fixture-import-turn",message:"Reconnecting… waiting for network"},undefined,"event_msg"),
    record({type:"reasoning",summary:[{type:"summary_text",text:"Recorded reasoning summary"}]}),
    record({type:"function_call",call_id:"fixture-tool",name:"collaboration.send_message",arguments:'{"target":"research","message":"Check source"}'}),
    record({type:"function_call_output",call_id:"fixture-tool",output:"Source checked"},"2026-10-11T00:00:05Z"),
    record({type:"custom_tool_call",call_id:"fixture-patch",name:"apply_patch",input:"*** Begin Patch\n*** Update File: src/example.ts\n-old\n+new\n+second\n*** End Patch"}),
    record({type:"message",role:"user",content:[{type:"input_text",text:"Also check the sources"}]}),
    record({type:"message",role:"assistant",phase:"commentary",content:[{type:"output_text",text:"I will keep checking this same turn."}]}),
    record({type:"message",role:"assistant",phase:"final_answer",content:[{type:"output_text",text:"Imported final answer remains visible."}]},"2026-10-11T00:00:10Z"),
    record({type:"task_complete",turn_id:"fixture-import-turn"},"2026-10-11T00:23:51Z","event_msg"),
  ].join("\n");
  const items=parseRolloutItems(raw);
  const outcomes=parseDurableTurnOutcomes(raw);
  await using app=await desktop({name:"imported-session-presentation"});
  await createAndSelectWorkspace(app,{path});await control(app,"session.create_task");
  await app.client.send("Input.dispatchKeyEvent",{type:"keyDown",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});
  await app.client.send("Input.dispatchKeyEvent",{type:"keyUp",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});
  await eventually(async()=>{expect(await evalIn(app,`Boolean(document.querySelector('[data-session-surface-id]'))`)).toBe(true);return true;},{within:10000});
  await evalIn(app,`(async()=>{
    const {useCodexSessionStore}=await import('/src/react-app/domains/session/codex-session-store.ts');
    const {restoreCodexSessionItems}=await import('/src/react-app/domains/session/sync/codex-transcript-adapter.ts');
    const id=document.querySelector('[data-session-surface-id]').getAttribute('data-session-surface-id');
    const session=useCodexSessionStore.getState().sessions[id].session;
    useCodexSessionStore.getState().upsertSession({...session,title:'Install the rea skill',status:'idle',turnId:null});
    await restoreCodexSessionItems({items:async()=>({ok:true,outcomes:${JSON.stringify(outcomes)},items:${JSON.stringify(items)}})},session.workspaceId,id);
  })()`,{awaitPromise:true});
  await eventually(async()=>{expect(await evalIn(app,`document.body.innerText`)).toContain("Imported final answer remains visible.");expect(await evalIn(app,`document.body.innerText`)).toContain("Install the rea skill");return true;},{within:10000});
  expect(await evalIn(app,`document.querySelector('h1').textContent.trim()`)).toBe("Install the rea skill");
  expect(await evalIn(app,`document.querySelector('[data-session-tab-active="true"]').textContent`)).toContain("Install the rea skill");
  expect(await evalIn(app,`Array.from(document.querySelectorAll('[data-turn-work-header]')).map(node=>node.textContent)`)).toContain("Worked for 23m 51s");
  expect(await evalIn(app,`Boolean(document.querySelector('[data-message-id] img'))`)).toBe(true);
  expect(await evalIn(app,`document.querySelector('[data-message-role="user"]').textContent`)).toContain('Inspect this screenshot');
  expect(await evalIn(app,`document.querySelector('[data-message-role="user"]').textContent`)).not.toContain('Files mentioned by the user');
  expect(await evalIn(app,`document.querySelector('[data-message-role="user"] img').alt`)).toBe('Screenshot.png');
  expect(await evalIn(app,`document.querySelectorAll('[data-turn-changeset]').length`)).toBe(1);
  expect(await evalIn(app,`document.querySelector('[data-turn-changeset]').textContent`)).toContain('+2');
  expect(await evalIn(app,`document.querySelector('[data-turn-changeset]').textContent`)).toContain('src/example.ts');
  expect(await evalIn(app,`document.querySelector('[data-turn-changeset]').textContent`)).not.toContain('details weren');
  const point=await evalIn(app,`(()=>{const r=document.querySelector('[data-file-change]').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await app.client.send("Input.dispatchMouseEvent",{type:"mouseMoved",x:point.x,y:point.y});
  await eventually(async()=>{expect(await evalIn(app,`Boolean(document.querySelector('[data-recorded-patch]'))`)).toBe(true);return true;},{within:5000});
  expect(await evalIn(app,`document.querySelector('[data-recorded-patch]').textContent`)).toContain('second');
  expect(await evalIn(app,`document.querySelector('[data-recorded-patch]').textContent`)).not.toContain('*** End Patch');
  await app.client.send("Input.dispatchMouseEvent",{type:"mouseMoved",x:0,y:0});
  await evalIn(app,`document.querySelector('[data-turn-work-header]').click()`);
  await eventually(async()=>{expect(await evalIn(app,`document.body.innerText`)).toContain("I will inspect the actual implementation.");return true;},{within:5000});
  expect(await evalIn(app,`document.body.innerText`)).not.toContain("Used function");
  expect(await evalIn(app,`document.body.innerText`)).toContain("Chronology finish and Identity finish started working");
  expect(await evalIn(app,`document.body.innerText`)).toContain("Identity finish finished");
  expect(await evalIn(app,`document.querySelectorAll('[data-collaboration-activity] [data-agent-avatar]').length`)).toBeGreaterThanOrEqual(3);
  expect(await evalIn(app,`document.querySelector('[data-network-status]').textContent`)).toContain("Reconnecting");
  expect(await evalIn(app,`document.body.innerText`)).toContain("Imported final answer remains visible.");
});
