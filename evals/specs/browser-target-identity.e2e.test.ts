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

test("Browser locator identities and wait states address the observed DOM node", { timeout: 180_000 }, async ({ evidence }) => {
  needs({ optIn: ["SOFIA_EVAL_E2E_TESTS"] });
  await using app = await desktop({ name: "browser-target-identity" });
  const fixture = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<!doctype html><title>Target identity fixture</title><button id="decoy" onclick="window.decoyCount=(window.decoyCount||0)+1">Decoy</button><button class="chosen" id="chosen" onclick="window.chosenCount=(window.chosenCount||0)+1;window.trusted=event.isTrusted">Chosen</button><div id="hidden" style="display:none">Hidden fixture</div><div id="visible">Visible fixture</div>`);
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
  const seen = JSON.parse(text(await call('await tab.see();')));
  const chosen = seen.elements.find((entry: { label: string }) => entry.label === 'Chosen');
  expect(chosen.index).toBeGreaterThan(0);
  const located = JSON.parse(text(await call('console.log(await tab.locator(".chosen"));')));
  expect(located).toHaveLength(1);
  expect(located[0].index).toBe(chosen.index);
  text(await call(`await tab.click({index:${located[0].index}});`));
  expect(JSON.parse(text(await call('console.log(await tab.evaluate("({chosen:window.chosenCount,decoy:window.decoyCount||0,trusted:window.trusted})"));')))).toEqual({chosen:1,decoy:0,trusted:true});
  // A locator may establish the first observation and must preserve old indices.
  text(await call('await tab.evaluate("delete window.__sofiaBrowserObservation");'));
  const first = JSON.parse(text(await call('console.log(await tab.locator(".chosen"));')));
  text(await call(`await tab.click({index:${first[0].index}});`));
  expect(text(await call('console.log(await tab.evaluate("window.chosenCount"));'))).toBe('2');
  text(await call('await tab.locator("#visible");'));
  text(await call(`await tab.click({index:${first[0].index}});`));
  expect(text(await call('console.log(await tab.evaluate("window.chosenCount"));'))).toBe('3');
  text(await call(`await tab.evaluate(${JSON.stringify('const inserted=document.createElement("button");inserted.textContent="Inserted decoy";inserted.onclick=()=>window.decoyCount=(window.decoyCount||0)+1;document.body.prepend(inserted);')});`));
  const byText = JSON.parse(text(await call('console.log(await tab.getByText("Chosen",{exact:true}));')));
  expect(byText.index).toBe(first[0].index);
  text(await call(`await tab.click({index:${byText.index}});`));
  expect(text(await call('console.log(await tab.evaluate("window.chosenCount"));'))).toBe('4');
  text(await call(`await tab.evaluate(${JSON.stringify('document.querySelector("#chosen").outerHTML="<button class=chosen id=chosen>Replacement</button>"')});`));
  expect((await call(`await tab.click({index:${first[0].index}});`)).error?.message).toContain('Observed element was replaced');
  expect(text(await call('console.log(await tab.evaluate("window.decoyCount||0"));'))).toBe('0');
  for (const [selector, state, expected] of [
    ['#hidden','attached',true], ['#hidden','visible',false], ['#hidden','hidden',true], ['#hidden','detached',false],
    ['#visible','visible',true], ['#visible','hidden',false], ['#visible','attached',true], ['#visible','detached',false],
    ['#absent','hidden',true], ['#absent','detached',true], ['#absent','visible',false], ['#absent','attached',false],
  ]) {
    expect(text(await call(`console.log(await tab.waitFor({selector:${JSON.stringify(selector)}},{state:${JSON.stringify(state)},timeout:0}));`))).toBe(String(expected));
  }
  text(await call(`await tab.evaluate(${JSON.stringify('setTimeout(()=>document.querySelector("#hidden").style.display="block",100)')});`));
  expect(text(await call('console.log(await tab.waitFor({selector:"#hidden"},{state:"visible",timeout:2000}));'))).toBe('true');
  text(await call(`await tab.evaluate(${JSON.stringify('setTimeout(()=>document.querySelector("#visible").remove(),100)')});`));
  expect(text(await call('console.log(await tab.waitFor({selector:"#visible"},{state:"detached",timeout:2000}));'))).toBe('true');
  expect((await call('await tab.waitFor({selector:"["},{state:"visible",timeout:2000});')).error?.message).toContain('not a valid selector');
  expect((await call('await tab.waitFor({selector:"body"},{state:"invalid"});')).error?.message).toContain('Unsupported wait state');
  evidence.recordAssertionEvidence('Locator target identity', 'Actual browser MCP locator indices click only the chosen button with trusted input, retain identity after another locator, establish first observations, and reject replaced nodes without clicking the decoy.', true);
  evidence.recordAssertionEvidence('Wait states', 'Visible, hidden, attached and detached each assert positive and negative real DOM cases, immediate reads, bounded timeout, delayed visibility/removal, and invalid-state errors.', true);
});
