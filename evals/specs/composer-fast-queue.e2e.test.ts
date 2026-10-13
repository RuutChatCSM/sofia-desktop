import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, onTestFinished } from "vitest";
import { control, createAndSelectWorkspace, evalIn, waitFor } from "@sofia/behaviors";
import { desktop } from "@sofia/hosts";
import { needs, test } from "@sofia/testkit";

test("composer drains the next queued draft when a fast turn completes before request settlement", { timeout: 180_000 }, async ({ evidence }) => {
  needs({ optIn: ["SOFIA_EVAL_E2E_TESTS"], placement: "local" });
  const path = await mkdtemp(join(tmpdir(), "sofia-fast-queue-"));
  onTestFinished(() => rm(path, { recursive: true, force: true }));
  await using app = await desktop({ name: "composer-fast-queue" });
  // The isolated profile has no provider credentials. Only the configuration
  // needed to mount the composer is supplied; every prompt is mocked below.
  await evalIn(app, `(()=>{
    const fetch=window.fetch.bind(window);
    const json=body=>new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json'}});
    window.__fastQueueSession={id:'codex-fast-queue-proof',threadId:'fast-queue-proof',title:'Fast queue proof',created:new Date().toISOString(),status:'idle',turnId:null,workspaceId:''};
    window.fetch=async(input,init)=>{
      const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;
      if(url.endsWith('/codex/config'))return json({ok:true,config:{defaultProviderId:'openai',model:'fixture-model',providers:[]}});
      if(url.endsWith('/codex/engine'))return json({ok:true,available:true,running:true,sessions:window.__fastQueueSession.workspaceId?[window.__fastQueueSession]:[]});
      if(url.endsWith('/codex/sessions')&&init?.method==='POST'){
        window.__fastQueueSession.workspaceId=url.match(/workspace\\/([^/]+)/)?.[1]??'';
        return json({ok:true,session:window.__fastQueueSession});
      }
      if(url.includes('/codex/sessions/codex-fast-queue-proof/items'))return json({ok:true,items:[],outcomes:[]});
      if(url.includes('/codex/')&&(url.endsWith('/prompt')||url.endsWith('/steer')))throw Error('Unexpected provider transport before fixture installed');
      return fetch(input,init);
    };
    window.dispatchEvent(new Event('sofia:codex-providers-changed'));
  })()`);
  await createAndSelectWorkspace(app, { path });
  await waitFor(app, `window.__sofiaControl.listActions().some(action=>action.id==='session.create_task'&&!action.disabled)`, { label: "composer fixture provider configured" });
  await control(app, "session.create_task");
  await waitFor(app, `Boolean(document.querySelector('[data-session-surface-id="codex-fast-queue-proof"]'))`, { label: "session mounted" });
  await evalIn(app, `(async()=>{
    const {useCodexSessionStore}=await import('/src/react-app/domains/session/codex-session-store.ts');
    const {useComposerStateStore}=await import('/src/react-app/domains/session/surface/composer-state-store.ts');
    const id=document.querySelector('[data-session-surface-id="codex-fast-queue-proof"]').getAttribute('data-session-surface-id');
    const session=useCodexSessionStore.getState().sessions[id].session;
    window.__fastQueueProof={id,store:useCodexSessionStore,composer:useComposerStateStore,requests:[],session,release:null};
    useCodexSessionStore.getState().upsertSession({...session,status:'running',turnId:'initial-turn'});
    const originalFetch=window.fetch.bind(window);
    window.fetch=async(input,init)=>{
      const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;
      if(url.includes('/codex/sessions/'+encodeURIComponent(id)+'/prompt')){
        window.__fastQueueProof.requests.push(JSON.parse(init.body).text);
        if(window.__fastQueueProof.requests.length===1) await new Promise(resolve=>{window.__fastQueueProof.release=resolve});
        return new Response(JSON.stringify({ok:true,session:{...session,status:'idle',turnId:null}}),{status:200,headers:{'content-type':'application/json'}});
      }
      return originalFetch(input,init);
    };
    for(const text of ['First queued task','Second queued task']) useComposerStateStore.getState().appendQueuedDraft(id,{mode:'prompt',text,parts:[{type:'text',text}],attachments:[]});
  })()`, { awaitPromise: true });
  await waitFor(app, `window.__fastQueueProof.composer.getState().queuedDrafts[window.__fastQueueProof.id]?.length===2`, { label: "two queued drafts retained during initial run" });
  await evalIn(app, `window.__fastQueueProof.store.getState().upsertSession({...window.__fastQueueProof.session,status:'idle',turnId:null})`);
  await waitFor(app, `window.__fastQueueProof.requests.length===1 && Boolean(window.__fastQueueProof.release)`, { label: "first queued request awaits response" });
  await waitFor(app, `window.__fastQueueProof.store.getState().sessions[window.__fastQueueProof.id].session.status==='running'`, { label: "optimistic turn start rendered" });
  await evalIn(app, `window.__fastQueueProof.store.getState().upsertSession({...window.__fastQueueProof.session,status:'idle',turnId:null})`);
  await waitFor(app, `window.__fastQueueProof.store.getState().sessions[window.__fastQueueProof.id].session.status==='idle'`, { label: "fast turn completed before response" });
  await evalIn(app, `new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`, { awaitPromise: true });
  expect(await evalIn(app, `window.__fastQueueProof.requests`)).toEqual(["First queued task"]);
  await evalIn(app, `window.__fastQueueProof.release()`);
  await waitFor(app, `window.__fastQueueProof.requests.length===2`, { label: "second queued task drains after request settlement" });
  expect(await evalIn(app, `window.__fastQueueProof.requests`)).toEqual(["First queued task", "Second queued task"]);
  expect(await evalIn(app, `window.__fastQueueProof.composer.getState().queuedDrafts[window.__fastQueueProof.id]??[]`)).toEqual([]);
  evidence.recordAssertionEvidence("Fast queued turn settlement", "Rendered Electron session and production queue drain submit two FIFO drafts once each even when the first turn becomes idle before its HTTP acceptance response. Transport and lifecycle are deterministic fixtures; no inference runs.", true);
});
