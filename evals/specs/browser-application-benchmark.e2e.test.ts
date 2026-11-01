import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { createAndSelectWorkspace, evalIn } from "@sofia/behaviors";
import { listTargets } from "@sofia/cdp";
import { desktop } from "@sofia/hosts";
import { needs, test } from "@sofia/testkit";
import { expect, onTestFinished } from "vitest";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
type Reply = { id: number; result?: { content: Array<{ type: string; text?: string; data?: string }> }; error?: { message: string } };

test("Disposable application benchmark completes validated form once without touching the preview", { timeout: 180_000 }, async ({ evidence }) => {
  needs({ optIn: ["SOFIA_EVAL_E2E_TESTS"] });
  await using app = await desktop({ name: "browser-application-benchmark" });
  const applications: Array<Record<string, string>> = [];
  let submissionRequests = 0;
  const fixture = createServer(async (request, response) => {
    if (request.method === "POST" && request.url === "/applications") {
      submissionRequests += 1;
      let body = "";
      for await (const chunk of request) body += chunk.toString();
      applications.push(JSON.parse(body));
      response.writeHead(200, {"content-type":"application/json"});
      response.end(JSON.stringify({reference:"fixture-001"}));
      return;
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<!doctype html><title>Disposable application</title><h1>Apply for engineering</h1><section><h2>Preview only</h2><label>Full name<input aria-label="Full name" id="preview-name"></label><button id="preview-action" onclick="window.previewActions=(window.previewActions||0)+1;document.querySelector('#preview-status').textContent='Preview changed'">Save preview</button><p id="preview-status">Preview unchanged</p></section><section id="step1"><h2>Application details</h2><form id="details"><label>Full name<input aria-label="Full name" name="fullName" required></label><div id="email-host"><label>Email<input aria-label="Email" type="email" name="email" required></label></div><button id="refresh" type="button">Refresh contact field</button><label>Role<select name="role" aria-label="Role" required><option value="">Choose role</option><option value="engineer">Engineer</option><option value="designer">Designer</option></select></label><p>Next appears after all details are valid.</p></form></section><section id="step2" hidden><h2>Eligibility</h2><form id="eligibility" novalidate><label>Work authorization<select name="authorization" aria-label="Work authorization" required><option value="">Choose authorization</option><option value="authorized">Already authorized</option><option value="sponsorship">Need sponsorship</option></select></label><div id="conditional" hidden><label>Sponsorship explanation<textarea name="explanation" aria-label="Sponsorship explanation"></textarea></label></div><button id="submit" type="submit">Submit application</button><p id="status" role="status"></p></form></section><script>
const details=document.querySelector('#details'),eligibility=document.querySelector('#eligibility');let draft={};
document.querySelector('#refresh').addEventListener('click',()=>document.querySelector('#email-host').innerHTML='<label>Email<input aria-label="Email" type="email" name="email" required></label>');
details.elements.namedItem('role').addEventListener('change',()=>{if(details.checkValidity()&&!document.querySelector('#next'))setTimeout(()=>{const next=document.createElement('button');next.type='button';next.id='next';next.textContent='Next';next.onclick=()=>{draft=Object.fromEntries(new FormData(details));document.querySelector('#step1').hidden=true;document.querySelector('#step2').hidden=false;};details.append(next);},300);});
eligibility.authorization.addEventListener('change',()=>{const required=eligibility.authorization.value==='sponsorship';document.querySelector('#conditional').hidden=!required;eligibility.explanation.required=required;});
eligibility.addEventListener('submit',async event=>{event.preventDefault();const status=document.querySelector('#status');if(!eligibility.checkValidity()){status.textContent='Complete the sponsorship explanation before submitting.';return;}document.querySelector('#submit').disabled=true;const result=await fetch('/applications',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...draft,...Object.fromEntries(new FormData(eligibility))})}).then(response=>response.json());status.textContent='Application received: '+result.reference;});
</script>`);
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
  if (!opened || typeof opened !== "object" || !("browser_url" in opened) || typeof opened.browser_url !== "string") throw new Error("Production browser broker missing");
  for (let attempt = 0; attempt < 60; attempt++) {
    const mounted = await evalIn(app, `(() => {const button=document.querySelector('button[aria-label="Browser"]:not(:disabled)');if(!button)return false;button.click();return Boolean(document.querySelector('[data-testid="browser-menu-trigger"]'));})()`);
    if (mounted) break;
    await sleep(250);
  }
  await evalIn(app, `window.__SOFIA_ELECTRON__.browser.setPresentation('docked')`, { awaitPromise: true });
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await evalIn(app, `document.querySelector('[data-testid="browser-panel-shell"]')?.getBoundingClientRect().width > 0`)) break;
    await sleep(100);
  }
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
  const see = async () => JSON.parse(text(await call('await tab.see();')));
  const initial = await see();
  expect(initial.text).toContain('Preview only');
  expect(initial.text).toContain('Application details');
  const names = initial.elements.filter((element: {label:string;role:string}) => element.role === 'textbox' && element.label === 'Full name');
  expect(names).toHaveLength(2);
  expect(initial.elements.some((element: {label:string}) => element.label === 'Next')).toBe(false);
  text(await call(`await tab.fill({index:${names[1].index}},"Ada Applicant");`));
  const email = initial.elements.find((element: {label:string;role:string}) => element.role === 'textbox' && element.label === 'Email');
  text(await call(`await tab.fill({index:${email.index}},"old@example.test");`));
  text(await call('await tab.click({role:"button",text:"Refresh contact field"});'));
  expect((await call(`await tab.fill({index:${email.index}},"wrong@example.test");`)).error?.message).toContain('replaced');
  const refreshed = await see();
  const freshEmail = refreshed.elements.find((element: {label:string;role:string}) => element.role === 'textbox' && element.label === 'Email');
  expect(freshEmail.value).toBe('');
  text(await call(`await tab.fill({index:${freshEmail.index}},"ada@example.test");`));
  text(await call('await tab.select({label:"Role"},"engineer");'));
  expect(text(await call('console.log(await tab.waitFor({role:"button",text:"Next"},{state:"visible",timeout:3000}));'))).toBe('true');
  const ready = await see();
  const next = ready.elements.find((element: {label:string;role:string}) => element.role === 'button' && element.label === 'Next');
  expect(next).toBeDefined();
  text(await call(`await tab.click({index:${next.index}});`));
  const eligibility = await see();
  expect(eligibility.text).toContain('Eligibility');
  expect(eligibility.elements.some((element: {label:string}) => element.label === 'Sponsorship explanation')).toBe(false);
  text(await call('await tab.select({label:"Work authorization"},"sponsorship");'));
  const conditional = await see();
  expect(conditional.elements.find((element: {label:string}) => element.label === 'Sponsorship explanation')).toBeDefined();
  text(await call('await tab.click({role:"button",text:"Submit application"});'));
  expect((await see()).text).toContain('Complete the sponsorship explanation before submitting.');
  expect(submissionRequests).toBe(0);
  expect(applications).toHaveLength(0);
  text(await call('await tab.fill({label:"Sponsorship explanation"},"I require employer sponsorship for this role.");'));
  text(await call('await tab.click({role:"button",text:"Submit application"});'));
  expect(text(await call('console.log(await tab.waitFor({role:"status",text:"Application received: fixture-001"},{state:"visible",timeout:5000}));'))).toBe('true');
  const completed = await see();
  expect(completed.text).toContain('Application received: fixture-001');
  expect(completed.text).toContain('Preview unchanged');
  expect((await call('await tab.click({role:"button",text:"Submit application"});')).error?.message).toContain('disabled');
  expect(completed.elements.find((element: {label:string;role:string}) => element.role === 'textbox' && element.label === 'Full name').value).toBe('');
  expect(submissionRequests).toBe(1);
  expect(applications).toEqual([{fullName:"Ada Applicant",email:"ada@example.test",role:"engineer",authorization:"sponsorship",explanation:"I require employer sponsorship for this role."}]);
  await mkdir(evidence.dir,{recursive:true});
  await writeFile(join(evidence.dir,'disposable-application-result.json'),JSON.stringify({submissionRequests,applications,scope:"Harness-level production-broker benchmark; no model inference or external application",unsupportedCoverage:["File upload is not exercised: the documented browser API used here exposes no file upload method."]},null,2));
  evidence.recordAssertionEvidence('Observed application workflow', 'Sofia MCP observations and user action APIs fill the real form despite duplicate names, reject a replaced email node, re-observe the replacement, wait for delayed Next, expose a conditional required question and show validation failure before accepting correction.', true);
  evidence.recordAssertionEvidence('One fixture application and no decoy action', 'Exactly one POST stores the intended application payload after correction; invalid submission sends no request, the preview field stays empty, preview status remains unchanged and final submit is disabled.', true);
});
