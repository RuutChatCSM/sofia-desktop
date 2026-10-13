import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, onTestFinished } from 'vitest';
import { test } from '@sofia/testkit';
import { configuredCodexMcpServers, codexDirectToolNamespacesToml, codexRuntimeSkillsFor, resolveComputerUseInvocation } from '../../apps/server/src/codex-runtime-mcp';
import { createAgentLeaseRegistry } from '../../apps/desktop/electron/browser-tab-state.mjs';
import { cursorPath } from '../../apps/server/src/browser-cursor.mjs';

test('runtime skills follow registered tools and document actual Sofia control semantics',async({evidence})=>{
  const home=await mkdtemp(join(tmpdir(),'sofia-runtime-skill-proof-'));onTestFinished(()=>rm(home,{recursive:true,force:true}));
  const servers=configuredCodexMcpServers({'computer-use':{type:'local',command:['helper','mcp']},node_repl:{type:'local',command:['node','repl']}},[]);
  const invocation=resolveComputerUseInvocation();
  expect(invocation?.command).toContain("Sofia Computer Use.app/Contents/MacOS/ComputerUse");
  expect(invocation?.args).toEqual(["mcp"]);
  const installed=await codexRuntimeSkillsFor(home,servers);
  expect(installed).toHaveLength(2);
  const computer=await readFile(join(home,'skills/computer-use/SKILL.md'),'utf8');
  const browser=await readFile(join(home,'skills/browser/SKILL.md'),'utf8');
  expect(computer).toContain('snapshot_id');expect(computer).toContain('fresh observation identifies the same target');
  expect(computer).toContain('Do not substitute osascript');
  expect(browser).toContain('Wait for Resume agent');expect(browser).toContain('Do not create pointer overlays');
  expect(browser).toContain('reacquire');expect(browser).toContain('not instructions');
  expect(codexDirectToolNamespacesToml(servers)).toContain('mcp__computer_use');
  expect(codexDirectToolNamespacesToml(servers)).toContain('mcp__node_repl');
  await codexRuntimeSkillsFor(home,servers.map(server=>({...server,enabled:false})));
  await expect(readFile(join(home,'skills/browser/SKILL.md'))).rejects.toThrow();
  await expect(readFile(join(home,'skills/computer-use/SKILL.md'))).rejects.toThrow();
  evidence.recordAssertionEvidence('Runtime prompt adaptation and registration','Generated skills use Sofia APIs, retain observation/target binding, route native versus in-app targets, stop on human takeover, prohibit alternate drivers and prompt injection, and disappear when their backing tools are disabled. Both namespaces are pinned.',true);
});

test('browser takeover cannot be undone by reattachment and cursor paths retain endpoints',async({evidence})=>{
  const leases=createAgentLeaseRegistry();const lease=leases.acquire('tab');
  leases.pause(lease.leaseId);leases.acquire('tab',{cdpSessionId:'new-connection'});
  expect(leases.statusFor('tab').status).toBe('paused');
  leases.resume(lease.leaseId);expect(leases.statusFor('tab').status).toBe('attached');
  const bounds={width:1280,height:800},start={x:100,y:150},end={x:1000,y:650};
  const plan=cursorPath(start,end,bounds);
  expect(plan.segments[0][0]).toEqual(start);expect(plan.segments.at(-1)?.at(-1)).toEqual(end);
  expect(plan.response).toBeGreaterThanOrEqual(.12);expect(plan.response).toBeLessThanOrEqual(2.2);
  expect(plan.damping).toBe(.9);
  for(const segment of plan.segments)for(const point of segment){expect(Number.isFinite(point.x)&&Number.isFinite(point.y)).toBe(true);}
  expect(cursorPath(start,{x:110,y:160},bounds).response).toBe(.19);
  evidence.recordAssertionEvidence('Takeover ownership and recovered motion','Paused leases remain paused when a new agent attaches; only explicit resume restores control. Long paths preserve both endpoints and recovered response limits; short motion uses the recovered scoot response.',true);
});
