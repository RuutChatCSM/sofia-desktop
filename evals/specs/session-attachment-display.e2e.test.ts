import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { control, createAndSelectWorkspace, evalIn } from "@sofia/behaviors";
import { desktop } from "@sofia/hosts";
import { needs, test, eventually } from "@sofia/testkit";
import { expect, onTestFinished } from "vitest";

test("session attachment renders its original name once without a duplicate UUID file strip", {timeout:180_000}, async ({evidence}) => {
  needs({optIn:["SOFIA_EVAL_E2E_TESTS"],placement:"local"});
  const path=await mkdtemp(join(tmpdir(),"sofia-attachment-view-"));
  onTestFinished(()=>rm(path,{recursive:true,force:true}));
  await using app=await desktop({name:"session-attachment-display"});
  await createAndSelectWorkspace(app,{path});
  await control(app,"session.create_task");
  await eventually(async()=>{
    expect(await evalIn(app,`window.__sofiaControl.listActions().some(action=>action.id==='eval.chat_transcript.seed'&&!action.disabled)`)).toBe(true);return true;
  },{within:10_000});
  await control(app,"eval.chat_transcript.seed",{userText:"Review this pasted file",pastedFile:true});
  await eventually(async()=>{
    expect(await evalIn(app,`document.querySelector('[data-message-role="user"] [aria-label="Message attachments"]')?.textContent`)).toContain("Pasted text.txt");return true;
  },{within:5000});
  expect(await evalIn(app,`Array.from(document.querySelectorAll('[data-message-role="user"] [aria-label="Message attachments"]')).length`)).toBe(1);
  expect(await evalIn(app,`document.querySelector('[data-message-role="user"]').parentElement.querySelector('[data-files-strip]')===null`)).toBe(true);
  expect(await evalIn(app,`document.querySelector('[data-message-role="user"]').textContent`)).not.toContain("40abf0e0");
  expect(await evalIn(app,`document.querySelector('[data-message-role="user"]').textContent`)).toContain("Review this pasted file");
  await control(app,"eval.chat_transcript.seed",{userText:"Answer only",answerOnly:true});
  await eventually(async()=>{
    expect(await evalIn(app,`Boolean(document.querySelector('[data-turn-work-summary]'))`)).toBe(true);return true;
  },{within:5000});
  expect(await evalIn(app,`document.querySelector('[data-turn-work-header]')===null`)).toBe(true);
  expect(await evalIn(app,`document.querySelector('[data-empty-work-details]')===null`)).toBe(true);
  expect(await evalIn(app,`document.querySelector('[data-final-answer]').textContent`)).toContain('A completed answer');
  await control(app,"eval.chat_transcript.seed",{userText:"Real activity fixture",collaborationFixture:true});
  await app.client.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await app.client.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await eventually(async()=>{
    expect(await evalIn(app,`Boolean(document.querySelector('[data-turn-work-header="done"]'))`)).toBe(true);return true;
  },{within:5000});
  expect(await evalIn(app,`getComputedStyle(document.querySelector('[data-turn-work-divider]')).borderBottomWidth`)).toBe('1px');
  expect(await evalIn(app,`document.querySelector('[data-turn-work-header="done"]').getAttribute('aria-expanded')`)).toBe('false');
  expect(await evalIn(app,`document.querySelector('[data-final-answer]').getBoundingClientRect().height`)).toBeGreaterThan(0);
  await evalIn(app,`document.querySelector('[data-turn-work-header="done"]').click()`);
  await eventually(async()=>{
    expect(await evalIn(app,`Array.from(document.querySelectorAll('[data-work-entry]')).some(node=>node.getBoundingClientRect().height>0)`)).toBe(true);return true;
  },{within:5000});
  expect(await evalIn(app,`document.querySelector('[data-turn-work-header="done"]').getAttribute('aria-expanded')`)).toBe('true');
  expect(await evalIn(app,`Array.from(document.querySelectorAll('[data-work-entry]')).map(node=>node.textContent).join('\\n')`)).toContain('Started an agent · 1 working');
  expect(await evalIn(app,`document.querySelector('[data-final-answer]').getBoundingClientRect().height`)).toBeGreaterThan(0);
  evidence.recordAssertionEvidence('Work disclosure follows actual activity', 'Timing-only turns have a non-interactive summary; turns with recorded work retain a disclosure that reveals visible activity blocks.',true);
  evidence.recordAssertionEvidence("One attachment presentation", "The actual session renderer retains user prose and one original-name attachment tray, without a second Files row or internal UUID filename.",true);
});
