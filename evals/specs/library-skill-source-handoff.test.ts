import { expect, vi } from "vitest";
import { test } from "@sofia/testkit";
import { createSofiaServerClient } from "../../apps/app/src/app/lib/sofia-server";
import { createExtensionsStore } from "../../apps/app/src/react-app/domains/settings/state/extensions-store";

const fixtures=vi.hoisted(()=>({local:vi.fn()}));
vi.mock("../../apps/app/src/app/utils",async importOriginal=>({...await importOriginal<object>(),isDesktopRuntime:()=>true}));
vi.mock("../../apps/app/src/app/lib/desktop",async importOriginal=>({...await importOriginal<object>(),listLocalSkills:fixtures.local}));

test("Library replaces an in-flight local inventory when its server connection becomes ready",async()=>{
 let finishLocal:(value:unknown)=>void=()=>{};
 fixtures.local.mockImplementation(()=>new Promise(resolve=>{finishLocal=resolve}));
 let connected=false;
 let serverReads=0;
 let finishServer:(value:{items:{name:string;path:string;description:string;scope:"global";readOnly:boolean;sourceDirectory:string}[]})=>void=()=>{};
 const client={...createSofiaServerClient({baseUrl:"http://fixture.invalid"}),listSkills:async()=>{serverReads++;return new Promise<{items:{name:string;path:string;description:string;scope:"global";readOnly:boolean;sourceDirectory:string}[]}>(resolve=>{finishServer=resolve})}};
 const connection=()=>({sofiaServerClient:connected?client:null,sofiaServerStatus:connected?"connected" as const:"disconnected" as const,sofiaServerCapabilities:null});
 // Only the snapshot is needed by refreshSkills; this fixture never starts other stores.
 const server={getSnapshot:connection} as Parameters<typeof createExtensionsStore>[0]["sofiaServer"];
 const store=createExtensionsStore({client:()=>null,projectDir:()=>"/workspace",selectedWorkspaceId:()=>"workspace",selectedWorkspaceRoot:()=>"/workspace",workspaceType:()=>"local",sofiaServer:server,sofiaServerConnection:connection,runtimeWorkspaceId:()=>"workspace",setBusy:()=>{},setBusyLabel:()=>{},setBusyStartedAt:()=>{},setError:()=>{}});
 try{
  const localRead=store.refreshSkills();
  await vi.waitFor(()=>expect(fixtures.local).toHaveBeenCalledTimes(1));
  connected=true;
  await store.refreshSkills();
  finishLocal([{name:"old-local",path:"/old",description:"Stale"}]);
  await localRead;
  await vi.waitFor(()=>expect(serverReads).toBe(1));
  expect(store.skills()).toEqual([]);
  finishServer({items:[{name:"reverse-engineer-anything",path:"/codex/rea/SKILL.md",description:"REA",scope:"global",readOnly:true,sourceDirectory:"/codex/rea"}]});
  await vi.waitFor(()=>expect(store.skills()).toEqual([{name:"reverse-engineer-anything",path:"/codex/rea/SKILL.md",description:"REA",readOnly:true,sourceDirectory:"/codex/rea",trigger:undefined}]));
  await store.refreshSkills();
  expect(serverReads).toBe(1);
 }finally{store.dispose();}
});
