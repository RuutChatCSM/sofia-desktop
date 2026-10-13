import { expect } from "vitest";
import { test } from "@sofia/testkit";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexSessionManager, isSubagentThread, subagentParentSessionId } from "../../apps/server/src/codex-sessions";
import { importNodeSqlite } from "../../apps/server/src/runtime-db";

const childSource = {subagent: {thread_spawn: {parent_thread_id: "parent", depth: 1, agent_path: "/root/audit", agent_nickname: "Lovelace"}}};

test("parentage identifies structured worker sources without hiding ordinary forks", () => {
  expect(isSubagentThread({source: JSON.stringify(childSource)})).toBe(true);
  expect(subagentParentSessionId({source: JSON.stringify(childSource)})).toBe("codex-parent");
  expect(isSubagentThread({source: "vscode", forkedFromId: "parent"})).toBe(false);
  expect(isSubagentThread({source: "subAgentThreadSpawn"})).toBe(true);
  expect(subagentParentSessionId({source: "subAgentThreadSpawn", parentThreadId: "parent"})).toBe("codex-parent");
});

test("manager lists the root chat while retaining nested child access for imported and engine records", async () => {
  const root = await mkdtemp(join(tmpdir(), "sofia-parent-list-"));
  const bin = join(root, "engine.mjs");
  let manager: CodexSessionManager | undefined;
  try {
    await mkdir(join(root, ".codex"));
    const {DatabaseSync} = await importNodeSqlite();
    const db = new DatabaseSync(join(root, ".codex", "state_5.sqlite"));
    db.exec("CREATE TABLE threads (id TEXT, rollout_path TEXT, title TEXT, created_at INTEGER, cwd TEXT, source TEXT, thread_source TEXT, archived INTEGER, name TEXT, first_user_message TEXT)");
    const insert = db.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    insert.run("parent", "", "raw prompt", 1, root, "vscode", "user", 0, "", "Install REA");
    const childRollout = join(root, "child.jsonl");
    await writeFile(childRollout, [JSON.stringify({type:"turn_context",payload:{turn_id:"child-turn"}}), JSON.stringify({type:"response_item",payload:{id:"answer",type:"message",role:"assistant",content:[{type:"output_text",text:"Child recorded result"}]}})].join("\n"));
    insert.run("child", childRollout, "", 2, root, JSON.stringify(childSource), "subagent", 0, "", "");
    insert.run("fork", "", "Independent fork", 3, root, "vscode", "user", 0, "", "");
    insert.run("archived", "", "Archived chat", 4, root, "vscode", "user", 1, "", "");
    db.close();
    await writeFile(join(root, ".codex", "session_index.jsonl"), JSON.stringify({id: "parent", thread_name: "Install the rea skill"}));
    await writeFile(bin, `import {createInterface} from 'node:readline';
if (process.argv.includes('--version')) {console.log('codex-cli 0.149.1');process.exit(0)}
createInterface({input:process.stdin}).on('line', line => {const m=JSON.parse(line);if(m.id===undefined)return;let result={};
if(m.method==='thread/resume') throw Error('Browsing must not resume');
if(m.method==='thread/items/list') result={data:[]};
if(m.method==='thread/list') {result=m.params.sourceKinds.some(k=>k.startsWith('subAgent')) ? {data:[]} : m.params.cursor ? {data:[{id:'older-root',cwd:${JSON.stringify(root)},name:'Older root'}]} : {data:[{id:'engine-child',cwd:${JSON.stringify(root)},source:${JSON.stringify(childSource)}}],nextCursor:'older'};}
console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result}));});`);
    manager = new CodexSessionManager({bin, cwd: root, interpreter: process.execPath, env: {REAL_HOME: root}}, null, true);
    await manager.start();
    const listed = manager.listSessions();
    expect(listed.map(session => session.threadId)).toEqual(["older-root", "fork", "parent"]);
    expect(listed.find(session => session.threadId === "parent")?.title).toBe("Install the rea skill");
    expect(manager.getSession("codex-child")?.parentSessionId).toBe("codex-parent");
    expect(manager.getSession("codex-engine-child")?.parentSessionId).toBe("codex-parent");
    expect(manager.getSession("codex-child")?.threadId).toBe("child");
    const children = manager.getSubagents("codex-parent");
    expect(children.map(child => child.threadId)).toEqual(["engine-child", "child"]);
    expect(children.find(child => child.threadId === "child")?.agentNickname).toBe("Lovelace");
    expect(children.find(child => child.threadId === "child")?.status).toBe("idle");
    expect(children.find(child => child.threadId === "child")?.agentStatus).toBe("unknown");
    await writeFile(childRollout, JSON.stringify({type:"event_msg",timestamp:"2026-10-11T02:14:10.909Z",payload:{type:"task_complete",turn_id:"child-turn"}}));
    expect(manager.getSubagents("codex-parent").find(child => child.threadId === "child")?.agentStatus).toBe("completed");
    await writeFile(childRollout, [JSON.stringify({type:"turn_context",payload:{turn_id:"child-turn"}}), JSON.stringify({type:"response_item",payload:{id:"answer",type:"message",role:"assistant",content:[{type:"output_text",text:"Child recorded result"}]}})].join("\n"));
    expect(manager.getSubagents("codex-parent").find(child => child.threadId === "child")?.agentStatus).toBe("unknown");
    await writeFile(childRollout, [
      {type:"session_meta",payload:{id:"child",timestamp:"2026-10-11T02:00:00.000Z",parent_thread_id:"parent"}},
      {type:"session_meta",payload:{id:"parent",timestamp:"2026-10-09T01:00:00.000Z"}},
      {type:"turn_context",payload:{turn_id:"inherited"}},
      {type:"response_item",timestamp:"2026-10-09T01:00:01.000Z",payload:{id:"inherited-answer",type:"message",role:"assistant",content:[{type:"output_text",text:"Inherited root result"}]}},
      {type:"event_msg",timestamp:"2026-10-11T02:00:01.000Z",payload:{type:"task_started",turn_id:"child-turn"}},
      {type:"response_item",timestamp:"2026-10-11T02:00:02.000Z",payload:{id:"answer",type:"message",role:"assistant",content:[{type:"output_text",text:"Child recorded result"}]}},
      {type:"event_msg",timestamp:"2026-10-11T02:00:10.000Z",payload:{type:"task_complete",turn_id:"child-turn"}},
    ].map(row=>JSON.stringify(row)).join("\n"));
    const childItems = await manager.getSubagentItems("codex-parent", "child");
    expect(childItems.some(entry => entry.item.type === "agentMessage" && entry.item.text === "Child recorded result")).toBe(true);
    expect(childItems.some(entry=>entry.item.id === "inherited-answer")).toBe(false);
    expect(childItems.find(entry=>entry.item.id === "answer")?.item.turnStartedAt).toBe(Date.parse("2026-10-11T02:00:01.000Z"));
    await expect(manager.getSubagentItems("codex-fork", "child")).rejects.toThrow("not a recorded subagent");
    const external = new DatabaseSync(join(root, ".codex", "state_5.sqlite"));
    external.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("later-child", "", "", 5, root, JSON.stringify(childSource), "subagent", 0, "", "");
    external.close();
    expect(manager.getSubagents("codex-parent").some(child => child.threadId === "later-child")).toBe(false);
    const refreshed = await manager.refreshSubagents("codex-parent");
    expect(refreshed.some(child => child.threadId === "later-child")).toBe(true);
    expect(manager.listSessions().some(child => child.threadId === "later-child")).toBe(false);
  } finally { await manager?.close(); await rm(root, {recursive: true, force: true}); }
});
