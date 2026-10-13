import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, onTestFinished } from "vitest";
import { control, createAndSelectWorkspace, evalIn, waitFor } from "@sofia/behaviors";
import { desktop } from "@sofia/hosts";
import { needs, test } from "@sofia/testkit";

test("composer Queue and Steer dispatch through the production submission path with opposite shortcut and persistence", { timeout: 180_000 }, async ({ evidence }) => {
  needs({ optIn: ["SOFIA_EVAL_E2E_TESTS"], placement: "local" });
  const path = await mkdtemp(join(tmpdir(), "sofia-follow-up-"));
  onTestFinished(() => rm(path, { recursive: true, force: true }));
  await using app = await desktop({ name: "composer-queue-steer" });
  await createAndSelectWorkspace(app, { path });
  await control(app, "session.create_task");
  await waitFor(app, `Boolean(document.querySelector('[data-session-surface-id]'))`, { label: "session mounted" });
  await app.client.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await app.client.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await evalIn(app, `(async()=>{
    const {useCodexSessionStore}=await import('/src/react-app/domains/session/codex-session-store.ts');
    const {useComposerStateStore}=await import('/src/react-app/domains/session/surface/composer-state-store.ts');
    const id=document.querySelector('[data-session-surface-id]').getAttribute('data-session-surface-id');
    const session=useCodexSessionStore.getState().sessions[id].session;
    window.__followUpProof={id,store:useCodexSessionStore,composer:useComposerStateStore,requests:[],session:{...session,status:'running',turnId:'fixture-active-turn'}};
    useCodexSessionStore.getState().upsertSession(window.__followUpProof.session);
    const originalFetch=window.fetch.bind(window);
    window.fetch=async(input,init)=>{
      const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;
      if(url.includes('/codex/sessions/'+encodeURIComponent(id)+'/steer') || url.includes('/codex/sessions/'+encodeURIComponent(id)+'/prompt')){
        window.__followUpProof.requests.push({url,body:JSON.parse(init.body)});
        return new Response(JSON.stringify({ok:true,session:window.__followUpProof.session}),{status:200,headers:{'content-type':'application/json'}});
      }
      return originalFetch(input,init);
    };
  })()`, { awaitPromise: true });
  await waitFor(app, `Boolean(document.querySelector('select[aria-label="Follow-up behavior"]'))`, { label: "busy follow-up controls" });
  expect(await evalIn(app, `document.querySelector('select[aria-label="Follow-up behavior"]').value`)).toBe("steer");
  const type = async (text: string) => {
    await evalIn(app, `document.querySelector('[contenteditable="true"][data-lexical-editor="true"]').focus()`);
    await app.client.send("Input.insertText", { text });
    await waitFor(app, `(document.querySelector('[contenteditable="true"][data-lexical-editor="true"]')?.innerText??'').trim()===${JSON.stringify(text)}`, { label: "follow-up draft entered" });
  };
  const mode = async (value: string) => {
    await evalIn(app, `(()=>{const select=document.querySelector('select[aria-label="Follow-up behavior"]');select.value=${JSON.stringify(value)};select.dispatchEvent(new Event('change',{bubbles:true}))})()`);
    await waitFor(app, `localStorage.getItem('sofia:follow-up-mode:v1')===${JSON.stringify(value)}`, { label: "follow-up preference persisted" });
  };
  const enter = async (modifiers = 0) => {
    await app.client.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers });
    await app.client.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers });
  };
  await mode("queue");
  await type("Run the report after this task");
  await enter();
  await waitFor(app, `window.__followUpProof.composer.getState().queuedDrafts[window.__followUpProof.id]?.length===1`, { label: "Enter queues" });
  expect(await evalIn(app, `window.__followUpProof.requests.length`)).toBe(0);
  await mode("steer");
  await type("Then check the references");
  await enter(10);
  await waitFor(app, `window.__followUpProof.composer.getState().queuedDrafts[window.__followUpProof.id]?.length===2`, { label: "opposite shortcut queues in steer mode" });
  expect(await evalIn(app, `window.__followUpProof.requests.length`)).toBe(0);
  await type("Use a concise format now");
  expect(await evalIn(app, `(()=>{const button=document.querySelector('button[aria-label="Steer current task"]');if(!(button instanceof HTMLButtonElement)||button.disabled)return false;button.click();return true})()`)).toBe(true);
  await waitFor(app, `window.__followUpProof.requests.length===1`, { label: "steer transport accepted" });
  expect(await evalIn(app, `window.__followUpProof.requests[0].url.endsWith('/steer')`)).toBe(true);
  expect(await evalIn(app, `window.__followUpProof.requests[0].body.text`)).toBe("Use a concise format now");
  expect(await evalIn(app, `window.__followUpProof.composer.getState().queuedDrafts[window.__followUpProof.id].length`)).toBe(2);
  await type("Keep the same task scope");
  await enter();
  await waitFor(app, `window.__followUpProof.requests.length===2`, { label: "Enter steers under the selected preference" });
  expect(await evalIn(app, `window.__followUpProof.requests[1].body.text`)).toBe("Keep the same task scope");
  expect(await evalIn(app, `window.__followUpProof.requests[1].url.endsWith('/steer')`)).toBe(true);
  // Two synchronous promotion attempts must claim the same queued draft once.
  expect(await evalIn(app, `(()=>{const button=[...document.querySelector('.sofia-composer-queue').querySelectorAll('button')].find(button=>button.textContent.trim()==='Steer');if(!(button instanceof HTMLButtonElement))return false;button.click();button.click();return true})()`)).toBe(true);
  await waitFor(app, `window.__followUpProof.requests.length===3`, { label: "queued promotion dispatched once" });
  expect(await evalIn(app, `window.__followUpProof.requests[2].body.text`)).toBe("Run the report after this task");
  expect(await evalIn(app, `window.__followUpProof.composer.getState().queuedDrafts[window.__followUpProof.id].length`)).toBe(1);
  await evalIn(app, `window.__followUpProof.store.getState().upsertSession({...window.__followUpProof.session,status:'idle',turnId:null})`);
  await waitFor(app, `window.__followUpProof.requests.length===4`, { label: "remaining draft drains on idle" });
  expect(await evalIn(app, `window.__followUpProof.requests[3].url.endsWith('/prompt')`)).toBe(true);
  expect(await evalIn(app, `window.__followUpProof.requests[3].body.text`)).toBe("Then check the references");
  expect(await evalIn(app, `window.__followUpProof.composer.getState().queuedDrafts[window.__followUpProof.id]??[]`)).toEqual([]);
  // Remounting the persisted preference module is covered separately; verify the
  // actual UI choice has been written for the next app launch here.
  expect(await evalIn(app, `localStorage.getItem('sofia:follow-up-mode:v1')`)).toBe("steer");
  evidence.recordAssertionEvidence("Queue and steer submission", "Real Electron composer, Lexical keyboard handlers, session submission handler and production HTTP client send exact guidance through the selected Steer button and Enter path while two queued drafts remain unsent; double promotion dispatches once and remaining draft drains as /prompt on idle. Backend acceptance is a deterministic transport fixture; no inference was run.", true);
});
