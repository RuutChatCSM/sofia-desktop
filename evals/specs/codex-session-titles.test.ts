import { expect } from "vitest";
import { test } from "@sofia/testkit";
import { parseCodexSessionTitles, threadDisplayTitle, threadTitleFromEngineText, isPlaceholderTaskTitle } from "../../apps/server/src/codex-session-titles";
import { getDisplaySessionTitle, isGeneratedSessionTitle } from "../../apps/app/src/app/lib/session-title";

test("desktop title index retains authored names and tolerates incomplete records", () => {
  const titles = parseCodexSessionTitles([
    JSON.stringify({ id: "rea", thread_name: "Install the rea skill" }),
    JSON.stringify({ id: "rea", thread_name: "Install REA / investigate ChatGPT" }),
    JSON.stringify({ id: "other", thread_name: "Sofia task" }),
    '{"id":"broken"',
  ].join("\n"));
  expect([...titles]).toEqual([["rea", "Install REA / investigate ChatGPT"]]);
});

test("engine names are preserved while old placeholders use preview or title metadata", () => {
  expect(threadDisplayTitle({ name: "My exact **release** title", preview: "other" })).toBe("My exact **release** title");
  expect(threadDisplayTitle({ name: "Sofia task", title: "Install the rea skill", preview: "raw" })).toBe("Install the rea skill");
  expect(threadDisplayTitle({ name: "New Sofia task", preview: "Review the release" })).toBe("Review the release");
  expect(isPlaceholderTaskTitle("Release task")).toBe(false);
});

test("first-message fallback uses actual request rather than pasted file metadata", () => {
  expect(threadTitleFromEngineText('# Files mentioned by the user:\n\n## Screenshot.png: /tmp/screenshot.png\n\n## My request:\nplease review the release notes')).toBe("please review the release notes");
  expect(threadTitleFromEngineText('[https://github.com/morluto/rea.git](https://github.com/morluto/rea.git) can u install this skill')).toBe("can u install this skill");
  expect(threadTitleFromEngineText('Review ' + 'release notes '.repeat(20)).length).toBeLessThanOrEqual(73);
});

test("sidebar and header do not expose historic placeholder names as real titles", () => {
  expect(isGeneratedSessionTitle("Sofia task")).toBe(true);
  expect(getDisplaySessionTitle("Sofia task", "Install the rea skill")).toBe("Install the rea skill");
  expect(getDisplaySessionTitle("My release", "other")).toBe("My release");
});

import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexSessionManager } from "../../apps/server/src/codex-sessions";

async function titleEngine(importTitles = false) {
  const root = await mkdtemp(join(tmpdir(), "sofia-title-proof-"));
  const bin = join(root, "engine.mjs");
  await writeFile(bin, `
import { createInterface } from 'node:readline';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const titlePath = ${JSON.stringify(join(root, 'title.json'))};
const title = () => existsSync(titlePath) ? JSON.parse(readFileSync(titlePath, 'utf8')) : '';
if (process.argv.includes('--version')) { console.log('codex-cli 0.149.1'); process.exit(0); }
const send = message => console.log(JSON.stringify(message));
const rl = createInterface({ input: process.stdin });
rl.on('line', line => {
 const m = JSON.parse(line); if (m.id === undefined) return;
 let result = {};
 if (m.method === 'thread/list') result = {data: title() ? [{id: 'native', name: title(), cwd: ${JSON.stringify(root)}}] : []};
 if (m.method === 'thread/name/set') writeFileSync(titlePath, JSON.stringify(m.params.name));
 if (m.method === 'thread/start') result = {threadId: 'native'};
 if (m.method === 'turn/start') {
  result = {threadId: 'native', turnId: 'first'};
  setTimeout(() => send({method: 'turn/completed', params: {threadId: 'native', turn: {id: 'first', status: 'completed'}}}), 25);
 }
 if (m.method === 'thread/read') result = {thread: {id: 'native', name: title() || 'Sofia task', preview: ''}};
 send({jsonrpc: '2.0', id: m.id, result});
});`);
  return { root, manager: new CodexSessionManager({ bin, cwd: root, interpreter: process.execPath, env: {REAL_HOME: root} }, null, importTitles) };
}

test("native Codex first turn gets a useful title even when engine title metadata is absent", async () => {
  const {root, manager} = await titleEngine();
  try {
    const session = await manager.createSession({ title: "Sofia task", workspaceId: "proof" });
    await manager.prompt(session.id, "Review release notes and fix installation");
    await expect.poll(() => manager.getSession(session.id)?.title).toBe("Review release notes and fix installation");
    await manager.close();
    const reopened = new CodexSessionManager({ bin: join(root, "engine.mjs"), cwd: root, interpreter: process.execPath });
    try {
      await reopened.start();
      expect(reopened.getSession(session.id)?.title).toBe("Review release notes and fix installation");
    } finally { await reopened.close(); }
  } finally { await manager.close(); await rm(root, {recursive: true, force: true}); }
});

test("native first-turn automatic naming preserves the user's explicit rename", async () => {
  const {root, manager} = await titleEngine();
  try {
    const session = await manager.createSession({ title: "New Sofia task", workspaceId: "proof" });
    await manager.prompt(session.id, "Review release notes");
    await manager.rename(session.id, "My release plan");
    await expect.poll(() => manager.getSession(session.id)?.status).toBe("idle");
    expect(manager.getSession(session.id)?.title).toBe("My release plan");
  } finally { await manager.close(); await rm(root, {recursive: true, force: true}); }
});


test("imported desktop root names refresh on list/open and never adopt a child's title", async () => {
  const {root, manager} = await titleEngine(true);
  try {
    await mkdir(join(root, ".codex"));
    const index = join(root, ".codex", "session_index.jsonl");
    const updatedTitles: string[] = [];
    manager.on(event => { if (event.type === "session.updated") updatedTitles.push(event.session.title); });
    const session = await manager.createSession({title: "New Sofia task", workspaceId: "proof"});
    await writeFile(index, JSON.stringify({id: "native-child", thread_name: "Child audit"}) + "\n" + JSON.stringify({id: "native", thread_name: "Install the rea skill"}));
    expect(manager.listSessions().find(entry => entry.id === session.id)?.title).toBe("Install the rea skill");
    await writeFile(index, JSON.stringify({id: "native", thread_name: "Install REA and review ChatGPT"}));
    expect(manager.getSession(session.id)?.title).toBe("Install REA and review ChatGPT");
    expect(updatedTitles).toContain("Install REA and review ChatGPT");
    await manager.rename(session.id, "My own title");
    await writeFile(index, JSON.stringify({id: "native", thread_name: "Stale desktop title"}));
    expect(manager.getSession(session.id)?.title).toBe("My own title");
  } finally { await manager.close(); await rm(root, {recursive: true, force: true}); }
});
