import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { control, createAndSelectWorkspace, evalIn } from "@sofia/behaviors";
import { desktop } from "@sofia/hosts";
import { needs, test, eventually } from "@sofia/testkit";
import { expect, onTestFinished } from "vitest";

test("HEIC paste decodes to a supported image and displays a full card above prose", { timeout:180_000 }, async ({evidence}) => {
  needs({optIn:["SOFIA_EVAL_E2E_TESTS"], placement:"local"});
  expect(process.platform).toBe("darwin");
  const directory=await mkdtemp(join(tmpdir(),"sofia-heic-proof-"));
  onTestFinished(()=>rm(directory,{recursive:true,force:true}));
  const png=join(directory,"input.png");
  await writeFile(png,Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7WQAAAAASUVORK5CYII=","base64"));
  const heic=join(directory,"photo.heic");
  execFileSync("/usr/bin/sips",["-s","format","heic",png,"--out",heic]);
  const bytes=Array.from(await readFile(heic));
  expect(bytes.length).toBeGreaterThan(0);
  await using app=await desktop({name:"composer-heic"});
  await createAndSelectWorkspace(app,{path:directory});
  await control(app,"session.create_task");
  await eventually(async()=>{expect(await evalIn(app,`window.__sofiaControl.listActions().some(a=>a.id==='composer.set_text'&&!a.disabled)`)).toBe(true); return true;},{within:10000});
  expect(await evalIn(app,`window.__SOFIA_ELECTRON__.images.decodeHeic(new Uint8Array(${JSON.stringify(bytes)})).then(b=>({length:b.length}),e=>({error:e.message}))`,{awaitPromise:true})).toMatchObject({length:expect.any(Number)});
  await app.client.send("Input.dispatchKeyEvent",{type:"keyDown",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});
  await control(app,"composer.set_text",{text:"my cofounder reported this"});
  await evalIn(app,`{
    const data=new DataTransfer(); data.items.add(new File([new Uint8Array(${JSON.stringify(bytes)})],'photo.heic',{type:'image/heic'}));
    document.querySelector('[data-sofia-composer-editor]').dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));
  }`);
  await evalIn(app,`document.querySelector('[data-sofia-composer-editor]').focus()`);
  await app.client.send("Input.insertText", { text: " extra detail" });
  await eventually(async()=>{expect(await evalIn(app,`(() => {const img=document.querySelector('[data-attachment-kind="image"] img'); return Boolean(img?.complete&&img.naturalWidth>0)})()`)).toBe(true);return true;},{within:15000});
  const state=await evalIn(app,`(async()=>{
    const editor=document.querySelector('[data-sofia-composer-editor]'); const card=editor.querySelector('[data-attachment-kind="image"]'); const img=card.querySelector('img');
    const prose=Array.from(editor.querySelectorAll('[data-lexical-text]')).find(n=>n.textContent.includes('my cofounder'));
    return {count:editor.querySelectorAll('[data-attachment-kind="image"]').length,name:card.title,width:card.getBoundingClientRect().width,height:card.getBoundingClientRect().height,cardTop:card.getBoundingClientRect().top,proseTop:prose.getBoundingClientRect().top,mime:(await fetch(img.src).then(r=>r.blob())).type,text:editor.textContent};
  })()`,{awaitPromise:true});
  expect(state).toMatchObject({count:1,name:"photo.heic",mime:"image/png"});
  expect(state.width).toBeCloseTo(154,0); expect(state.height).toBeCloseTo(118,0);
  expect(state.proseTop).toBeGreaterThan(state.cardTop+100);
  expect(state.text.match(/my cofounder reported this/g)).toHaveLength(1);
  expect(state.text).toContain("extra detail");
  expect(await evalIn(app,`window.__SOFIA_ELECTRON__.images.decodeHeic(new Uint8Array([1,2,3])).then(()=>false,()=>true)`,{awaitPromise:true})).toBe(true);
  await control(app,"composer.set_text",{text:""});
  await evalIn(app,`{
    const editor=document.querySelector('[data-sofia-composer-editor]'); editor.focus();
    const data=new DataTransfer(); data.items.add(new File([new Uint8Array(${JSON.stringify(bytes)})],'empty-first.heic',{type:'image/heic'}));
    editor.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));
  }`);
  await eventually(async()=>{expect(await evalIn(app,`document.querySelector('[data-sofia-composer-editor] [data-attachment-kind="image"]')?.title`)).toBe('empty-first.heic');return true;},{within:5000});
  // No focus() after paste: the caret must remain directly usable.
  await app.client.send("Input.insertText", { text: "Typed after empty image paste" });
  await eventually(async()=>{expect(await evalIn(app,`(() => {const e=document.querySelector('[data-sofia-composer-editor]'); const img=e.querySelector('img'); return {text:e.textContent,loaded:Boolean(img?.complete&&img.naturalWidth>0)};})()`)).toMatchObject({text:expect.stringContaining("Typed after empty image paste"),loaded:true});return true;},{within:15000});
  expect(await evalIn(app,`(() => {const e=document.querySelector('[data-sofia-composer-editor]'); const card=e.querySelector('[data-attachment-kind="image"]'); const text=Array.from(e.querySelectorAll('[data-lexical-text]')).find(n=>n.textContent==='Typed after empty image paste'); return text.getBoundingClientRect().top>card.getBoundingClientRect().bottom;})()`)).toBe(true);

  evidence.recordAssertionEvidence("Actual native HEIC conversion and composer paste","A real HEIC generated by macOS codecs enters the Electron paste pipeline; its loaded thumbnail uses PNG bytes, preserves the original filename, displays one 154×118 card above unchanged prose, and invalid bytes reject.",true);
});
