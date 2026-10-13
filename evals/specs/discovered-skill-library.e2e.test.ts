import { expect } from "vitest";
import { evalIn, waitFor } from "@sofia/behaviors";
import { desktop } from "@sofia/hosts";
import { needs, test } from "@sofia/testkit";

test("Library shows discovered sources and opens external skills without uninstalling them",{timeout:180_000},async()=>{
 needs({optIn:["SOFIA_EVAL_E2E_TESTS"],placement:"local"});
 await using app=await desktop({name:"discovered-skill-library"});
 await evalIn(app,`(async()=>{
  const {McpView}=await import('/src/react-app/domains/settings/pages/mcp-view.tsx');
  const {CloudSessionProvider}=await import('/src/react-app/domains/settings/cloud/cloud-session-provider.tsx');
  const {DenAuthProvider}=await import('/src/react-app/domains/cloud/den-auth-provider.tsx');
  const React=(await import('/node_modules/.vite/deps/react.js')).default;
  const {createRoot}=(await import('/node_modules/.vite/deps/react-dom_client.js')).default;
  window.__libraryProof={uninstalls:0,reads:0};
  function Proof(){const [detail,setDetail]=React.useState(null);const [tick,setTick]=React.useState(0);window.__libraryProof.bump=()=>setTick(value=>value+1);const [skills,setSkills]=React.useState([{name:'reverse-engineer-proof',path:'/shared/reverse-engineer-proof/SKILL.md',sourceDirectory:'/shared/reverse-engineer-proof',readOnly:true,description:'Discovered through the engine'}]);window.__libraryProof.clear=()=>setSkills([]);return React.createElement(McpView,{busy:false,selectedWorkspaceRoot:'/proof',isRemoteWorkspace:false,installedSkills:skills.map(skill=>({...skill})),detailId:detail,onDetailIdChange:setDetail,mcpServers:[],mcpStatus:null,mcpLastUpdatedAt:null,mcpStatuses:{},mcpConnectingName:null,selectedMcp:null,setSelectedMcp:()=>{},quickConnect:[],connectMcp:async()=>({ok:true}),authorizeMcp:()=>{},logoutMcpAuth:()=>{},removeMcp:()=>{},uninstallSkill:()=>{window.__libraryProof.uninstalls++},readSkill:async()=>{window.__libraryProof.reads++;return {content:'Read-only external skill instructions.'}}})}
  const el=document.createElement('div');el.id='discovered-library-proof';document.body.append(el);createRoot(el).render(React.createElement(DenAuthProvider,null,React.createElement(CloudSessionProvider,null,React.createElement(Proof))));
 })()`,{awaitPromise:true});
 await waitFor(app,`document.querySelector('#discovered-library-proof')?.textContent.includes('reverse-engineer-proof')`,{label:"discovered skill listed"});
 expect(await evalIn(app,`document.querySelector('#discovered-library-proof').textContent`)).toContain('/shared/reverse-engineer-proof');
 await evalIn(app,`[...document.querySelectorAll('#discovered-library-proof button')].find(button=>button.textContent.includes('reverse-engineer-proof')).click()`);
 await waitFor(app,`document.body.textContent.includes('Read-only external skill instructions.')`,{label:"external skill content opens"});
 expect(await evalIn(app,`[...document.querySelectorAll('#discovered-library-proof button')].some(button=>/uninstall/i.test(button.textContent))`)).toBe(false);
 await evalIn(app,`(async()=>{for(let i=0;i<4;i++){window.__libraryProof.bump();await new Promise(requestAnimationFrame);}})()`,{awaitPromise:true});
 expect(await evalIn(app,`window.__libraryProof.reads`)).toBe(1);
 expect(await evalIn(app,`document.body.textContent.includes('Read-only external skill instructions.')`)).toBe(true);
 expect(await evalIn(app,`window.__libraryProof.uninstalls`)).toBe(0);
});
