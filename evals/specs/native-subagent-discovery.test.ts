import { expect } from "vitest";
import { test } from "@sofia/testkit";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexSessionManager } from "../../apps/server/src/codex-sessions";

test("refresh discovers native children with read metadata without resuming or adding sidebar chats", async () => {
  const root = await mkdtemp(join(tmpdir(), "sofia-native-children-"));
  const bin = join(root, "engine.mjs");
  const rollout = join(root, "child.jsonl");
  let manager: CodexSessionManager | undefined;
  try {
    await writeFile(rollout, JSON.stringify({type:"event_msg",timestamp:"2026-10-11T15:49:16Z",payload:{type:"task_started",turn_id:"child-turn"}}));
    await writeFile(bin, `import {createInterface} from 'node:readline';
if(process.argv.includes('--version')){console.log('sofia-cli 0.1.4');process.exit(0)}
let reads=0;
createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;let result={};
if(m.method==='thread/resume'||m.method==='turn/start')throw Error('Discovery must not run a worker');
if(m.method==='thread/list')result={data:m.params.sourceKinds.includes('subAgentThreadSpawn')?[{id:'child',source:'subAgentThreadSpawn'},{id:'other',source:{subagent:{thread_spawn:{parent_thread_id:'other-parent'}}}},{id:'ordinary',source:'vscode',forkedFromId:'parent'}]:[{id:'parent',cwd:${JSON.stringify(root)},name:'Parent chat'}]};
if(m.method==='thread/read'){if(m.params.threadId!=='child')throw Error('Unrelated child must not be read');result={thread:{...(++reads>1?{name:'Custom worker title'}:{}),id:'child',preview:'Inherited parent prompt',cwd:${JSON.stringify(root)},rolloutPath:${JSON.stringify(rollout)},source:{subagent:{thread_spawn:{parent_thread_id:'parent',depth:1,agent_path:'/root/frontend_inspect',agent_nickname:'Confucius'}}}}};}
console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result}));});`);
    manager = new CodexSessionManager({bin,cwd:root,interpreter:process.execPath}, "workspace", false);
    await manager.start();
    expect(manager.getSubagents("codex-parent")).toEqual([]);
    const children = await manager.refreshSubagents("codex-parent");
    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({id:"codex-child",threadId:"child",parentSessionId:"codex-parent",agentPath:"/root/frontend_inspect",agentNickname:"Confucius",title:"Frontend inspect",agentStatus:"working"});
    expect(manager.listSessions().map(session=>session.threadId)).toEqual(["parent"]);
    await writeFile(rollout, JSON.stringify({type:"event_msg",timestamp:"2026-10-11T15:51:07Z",payload:{type:"task_complete",turn_id:"child-turn"}}));
    expect((await manager.refreshSubagents("codex-parent"))[0]).toMatchObject({agentStatus:"completed",title:"Custom worker title"});
    expect(manager.getSession("codex-other")).toBeNull();
  } finally { await manager?.close(); await rm(root,{recursive:true,force:true}); }
});
