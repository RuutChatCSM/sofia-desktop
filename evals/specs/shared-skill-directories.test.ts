import { expect } from "vitest";
import { test } from "@sofia/testkit";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sharedCodexSkillRoots } from "../../apps/server/src/codex-skill-roots";
import { ManagedCodexEngine } from "../../apps/server/src/managed-codex";
import { discoveredSkillInventory } from "../../apps/server/src/codex-skill-inventory";

test("shared roots default to Codex, expand real home, deduplicate and allow disabling independently", () => {
 expect(sharedCodexSkillRoots({}, "/real/home")).toEqual(["/real/home/.codex/skills"]);
 expect(sharedCodexSkillRoots({skills:{additionalDirectories:["~/custom", "/shared", "/shared", "~/.codex/skills"]}}, "/real/home")).toEqual(["/real/home/.codex/skills", "/real/home/custom", "/shared"]);
 expect(sharedCodexSkillRoots({skills:{discoverCodexSkills:false,additionalDirectories:["/shared"]}}, "/real/home")).toEqual(["/shared"]);
 expect(()=>sharedCodexSkillRoots({skills:{additionalDirectories:["relative"]}}, "/real/home")).toThrow("absolute paths");
});

test("bundled engine discovers extra SKILL.md directories and removes them through its refresh API", async () => {
 const root=await mkdtemp(join(tmpdir(),"sofia-extra-skills-"));
 const first=join(root,".codex","skills");
 const second=join(root,"custom");
 const engine=new ManagedCodexEngine({bin:resolve("../apps/desktop/resources/sidecars/sofia"),cwd:root,codexHome:join(root,"engine-home")});
 try {
  await mkdir(join(root,"engine-home"),{recursive:true});
  for(const [directory,name] of [[first,"codex-proof-skill"],[second,"custom-proof-skill"]]){
   await mkdir(join(directory,name),{recursive:true});
   await writeFile(join(directory,name,"SKILL.md"),`---\nname: ${name}\ndescription: Proof of extra skill root discovery\n---\nRead-only test instructions.\n`);
  }
  await engine.initialize();
  await engine.request("skills/extraRoots/set",{extraRoots:[first,second]});
  const response=await engine.request("skills/list",{cwds:[root],forceReload:true});
  const catalog=JSON.stringify(response);
  expect(discoveredSkillInventory(response,[])).toEqual(expect.arrayContaining([expect.objectContaining({name:"codex-proof-skill",sourceDirectory:await realpath(join(first,"codex-proof-skill")),readOnly:true}),expect.objectContaining({name:"custom-proof-skill",sourceDirectory:await realpath(join(second,"custom-proof-skill")),readOnly:true})]));
  expect(catalog).toContain("codex-proof-skill");expect(catalog).toContain("custom-proof-skill");
  await engine.request("skills/extraRoots/set",{extraRoots:[second]});
  const disabled=JSON.stringify(await engine.request("skills/list",{cwds:[root],forceReload:true}));
  expect(disabled).not.toContain("codex-proof-skill");expect(disabled).toContain("custom-proof-skill");
 }finally{await engine.close();await rm(root,{recursive:true,force:true});}
});

test("manager applies roots at startup and refreshes existing engine without restarting turns", async () => {
 const {CodexSessionManager}=await import("../../apps/server/src/codex-sessions");
 const {readFile}=await import("node:fs/promises");
 const root=await mkdtemp(join(tmpdir(),"sofia-skill-refresh-"));
 const log=join(root,"roots.jsonl");const bin=join(root,"fake.mjs");
 const manager=new CodexSessionManager({bin,cwd:root,interpreter:process.execPath,skillRoots:["/real/.codex/skills"]},"proof",false);
 try{
  await writeFile(bin,`import {createInterface} from 'node:readline';import {appendFileSync} from 'node:fs';if(process.argv.includes('--version')){console.log('sofia-cli 0.1.4');process.exit(0)};createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;if(m.method==='turn/start'||m.method==='thread/resume')throw Error('must not start work');if(m.method==='skills/extraRoots/set')appendFileSync(${JSON.stringify(log)},JSON.stringify(m.params.extraRoots)+'\\n');console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:m.method==='thread/list'?{data:[]}: {}}));});`);
  await manager.start();
  await manager.setSkillRoots(["/real/.codex/skills"]);
  await manager.setSkillRoots(["/shared"]);
  await manager.setSkillRoots([]);
  expect((await readFile(log,"utf8")).trim().split("\n").map(line=>JSON.parse(line))).toEqual([["/real/.codex/skills"],["/shared"],[]]);
 }finally{await manager.close();await rm(root,{recursive:true,force:true});}
});
