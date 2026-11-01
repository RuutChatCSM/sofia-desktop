import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { createAndSelectWorkspace, evalIn } from "@sofia/behaviors";
import { listTargets } from "@sofia/cdp";
import { desktop } from "@sofia/hosts";
import { eventually, needs, test } from "@sofia/testkit";
import { expect, onTestFinished } from "vitest";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
type Reply = { id: number; result?: { content: Array<{ type: string; text?: string; data?: string }> }; error?: { message: string } };

test("Browser select validates options and updates forms while history failures stay visible", { timeout: 180_000 }, async ({ evidence }) => {
  needs({ optIn: ["SOFIA_EVAL_E2E_TESTS"] });
  await using app = await desktop({ name: "browser-form-history" });
  const fixture = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<!doctype html><title>Form and history fixture</title><select id="plan" aria-label="Plan"><option value="">Choose</option value="basic">Basic</option><option value="pro">Pro</option><option value="locked" disabled>Locked</option><optgroup label="Locked group" disabled><option value="group">Group locked</option></optgroup></select><button id="submit" disabled>Submit</button><select id="disabled" disabled><option value="before">Before</option><option value="after">After</option></select><select id="revert"><option value="before">Before</option><option value="after">After</option></select><script>window.planEvents=[];const plan=document.querySelector('#plan');plan.addEventListener('input',event=>{window.planEvents.push({type:event.type,trusted:event.isTrusted});window.inputValue=plan.value;});plan.addEventListener('change',event=>{window.planEvents.push({type:event.type,trusted:event.isTrusted});document.querySelector('#submit').disabled=window.inputValue!==plan.value||plan.value==='';});document.querySelector('#revert').addEventListener('change',event=>event.target.value='before');window.disabledEvents=0;document.querySelector('#disabled').addEventListener('change',()=>window.disabledEvents++);</script>`);
  });
  await new Promise<void>(resolve => fixture.listen(0, "127.0.0.1", resolve));
  onTestFinished(() => fixture.close());
  const address = fixture.address();
  if (!address || typeof address === 'string') throw new Error('Fixture did not bind');
  const url = `http://127.0.0.1:${address.port}/`;
  const workspace = await createAndSelectWorkspace(app, { path: `/tmp/sofia-browser-observation-${Date.now()}` });
  await app.client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await app.client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await evalIn(app, `window.__SOFIA_ELECTRON__.browser.setScope(${JSON.stringify("workspace:")}+${JSON.stringify(workspace.workspaceId)})`, { awaitPromise: true });
  const opened = await evalIn(app, `window.__SOFIA_ELECTRON__.browser.openUrl(${JSON.stringify(url)}, 'builtin')`, { awaitPromise: true });
  if (!opened || typeof opened !== "object" || !("browser_url" in opened) || typeof opened.browser_url !== "string" || !("tab_id" in opened) || typeof opened.tab_id !== "string") throw new Error("Production browser broker missing");
  await evalIn(app, `document.querySelector('button[aria-label="Browser"]')?.click()`);
  await evalIn(app, `window.__SOFIA_ELECTRON__.browser.setPresentation('docked')`, { awaitPromise: true });
  const broker = { baseUrl: opened.browser_url };
  let target;
  for (let attempt = 0; attempt < 60; attempt++) {
    target = (await listTargets(broker.baseUrl)).find(entry => entry.url === url);
    if (target) break;
    await sleep(150);
  }
  if (!target) throw new Error('Fixture tab missing');
  const repl = spawn(process.execPath, [fileURLToPath(new URL('../../apps/server/src/sofia-browser-repl.mjs', import.meta.url))], { env: { ...process.env, SOFIA_BROWSER_CDP_URL: broker.baseUrl }, stdio: ['pipe', 'pipe', 'pipe'] });
  onTestFinished(() => { repl.kill(); });
  repl.stderr.resume();
  let nextId = 1, buffer = '';
  const pending = new Map<number, (reply: Reply) => void>();
  repl.stdout.on('data', chunk => {
    buffer += chunk.toString();
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const reply: Reply = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      pending.get(reply.id)?.(reply);
      pending.delete(reply.id);
    }
  });
  const call = (code: string) => new Promise<Reply>((resolve, reject) => {
    const id = nextId++;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`Browser MCP call ${id} timed out`)); }, 45_000);
    pending.set(id, reply => { clearTimeout(timeout); resolve(reply); });
    repl.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'js', arguments: { code } } }) + '\n');
  });
  const text = (reply: Reply) => {
    expect(reply.error).toBeUndefined();
    return reply.result?.content.map(entry => entry.text ?? '').join('') ?? '';
  };
  text(await call(`globalThis.browser=(await setupBrowserRuntime()).browsers.get('iab');globalThis.tabId=${JSON.stringify(target.id)};globalThis.tab=await browser.tabs.get(tabId);`));
  const state = () => call(`console.log(await tab.evaluate(${JSON.stringify('({value:document.querySelector("#plan").value,disabled:document.querySelector("#submit").disabled,events:window.planEvents})')}));`).then(reply => JSON.parse(text(reply)));
  expect(await state()).toEqual({value:"",disabled:true,events:[]});
  const selection = JSON.parse(text(await call('console.log(await tab.select({selector:"#plan"},"pro"));')));
  expect(selection).toEqual({ok:true,value:"pro",eventSource:"synthetic"});
  expect(await state()).toEqual({value:"pro",disabled:false,events:[{type:"input",trusted:false},{type:"change",trusted:false}]});
  for (const [value, error] of [["missing","does not exist"],["locked","is disabled"],["group","is disabled"]]) {
    expect((await call(`await tab.select({selector:"#plan"},${JSON.stringify(value)});`)).error?.message).toContain(error);
  }
  expect(await state()).toEqual({value:"pro",disabled:false,events:[{type:"input",trusted:false},{type:"change",trusted:false}]});
  expect((await call('await tab.select({selector:"#disabled"},"after");')).error?.message).toContain('Select is disabled');
  expect(JSON.parse(text(await call(`console.log(await tab.evaluate(${JSON.stringify('[document.querySelector("#disabled").value,window.disabledEvents]')}));`)))).toEqual(["before",0]);
  expect((await call('await tab.select({selector:"#revert"},"after");')).error?.message).toContain('did not retain');
  expect(text(await call(`console.log(await tab.evaluate(${JSON.stringify('document.querySelector("#revert").value')}));`))).toBe('before');
  text(await call(`await tab.evaluate(${JSON.stringify('history.pushState({},"","/one");history.pushState({},"","/two")')});`));
  expect(text(await call('console.log(await tab.forward());'))).toBe('false');
  expect(text(await call('console.log(await tab.back());'))).toBe('true');
  await eventually(async () => { expect(text(await call('console.log(await tab.evaluate("location.pathname"));'))).toBe('/one'); return true; }, {within:5000});
  expect(text(await call('console.log(await tab.forward());'))).toBe('true');
  await eventually(async () => { expect(text(await call('console.log(await tab.evaluate("location.pathname"));'))).toBe('/two'); return true; }, {within:5000});
  await evalIn(app, `window.__SOFIA_ELECTRON__.browser.agentLease('pause',{tabId:${JSON.stringify(opened.tab_id)}})`, {awaitPromise:true});
  expect((await call('await tab.back();')).error?.message).toContain('control belongs to the user');
  expect((await call('await tab.forward();')).error?.message).toContain('control belongs to the user');
  await evalIn(app, `window.__SOFIA_ELECTRON__.browser.agentLease('resume',{tabId:${JSON.stringify(opened.tab_id)}})`, {awaitPromise:true});
  expect(text(await call('console.log(await tab.evaluate("location.pathname"));'))).toBe('/two');
  evidence.recordAssertionEvidence('Select state and event contract', 'Selecting an available option enables a dynamic form using input then change events, explicitly reported as synthetic. Missing/disabled options and disabled controls leave values and events unchanged; a page reverting the selection produces an error.', true);
  evidence.recordAssertionEvidence('History command outcomes', 'Real same-document backward/forward transitions reach intended URLs, a missing forward entry returns false, and production takeover command refusals propagate as errors without navigating.', true);
});
