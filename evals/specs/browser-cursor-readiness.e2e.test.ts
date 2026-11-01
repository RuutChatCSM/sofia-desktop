import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { createAndSelectWorkspace, evalIn } from "@sofia/behaviors";
import { connect, debuggerUrlFor, evaluate, listTargets } from "@sofia/cdp";
import { desktop } from "@sofia/hosts";
import { eventually, needs, test } from "@sofia/testkit";
import { expect, onTestFinished } from "vitest";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
type Reply = { id: number; result?: { content: Array<{ type: string; text?: string; data?: string }> }; error?: { message: string } };

test("Cursor animation stalls are bounded and leave form state unchanged", { timeout: 180_000 }, async ({ evidence }) => {
  needs({ optIn: ["SOFIA_EVAL_E2E_TESTS"] });
  await using app = await desktop({ name: "browser-cursor-readiness" });
  const fixture = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<!doctype html><title>Cursor readiness fixture</title><button style="margin:30px" id="start">Start position</button><label style="margin-left:300px">Plan<select aria-label="Plan"><option value="before">Before</option><option value="after">After</option></select></label><button style="display:block;margin:100px" onclick="document.querySelector('#clicks').textContent='Clicks '+(++window.clicks)">Apply</button><p id="clicks">Clicks 0</p><p id="events">Events 0</p><script>window.clicks=0;window.events=0;document.querySelector('select').addEventListener('input',()=>document.querySelector('#events').textContent='Events '+(++window.events));document.querySelector('select').addEventListener('change',()=>document.querySelector('#events').textContent='Events '+(++window.events));</script>`);
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
  const reattachBrowserView = async () => {
    const bounds = await evalIn(app, `(() => {const rect=document.querySelector('[data-testid="browser-canvas"]')?.getBoundingClientRect();return rect?{x:rect.left,y:rect.top,width:rect.width,height:rect.height}:null;})()`);
    if (!bounds || bounds.width < 48 || bounds.height < 48) throw new Error(`Browser canvas is not measurable: ${JSON.stringify(bounds)}`);
    await evalIn(app, `window.__SOFIA_ELECTRON__.browser.show(${JSON.stringify(bounds)})`, { awaitPromise: true });
  };
  await reattachBrowserView();
  text(await call(`globalThis.browser=(await setupBrowserRuntime()).browsers.get('iab');globalThis.tabId=${JSON.stringify(target.id)};globalThis.tab=await browser.tabs.get(tabId);`));
  await reattachBrowserView();
  text(await call('await tab.see();await tab.hover({role:"button",text:"Start position"});'));
  const cursorTarget = await eventually(async () => {
    const found=(await listTargets(app.handle.cdpUrl)).find(entry=>entry.title==='Sofia browser cursor');
    if(!found) throw new Error('Cursor overlay missing'); return found;
  },{within:5000});
  const overlay=await connect(debuggerUrlFor(app.handle.cdpUrl,cursorTarget));
  onTestFinished(()=>overlay.close());
  await evaluate(overlay,'window.originalRAF=window.requestAnimationFrame;window.requestAnimationFrame=()=>1;true');
  await reattachBrowserView();
  const began=Date.now();
  expect((await call('await tab.select({label:"Plan"},"after");')).error?.message).toContain('animation-timeout');
  expect(Date.now()-began).toBeLessThan(6000);
  expect(text(await call('console.log(await tab.inputValue({label:"Plan"}));'))).toBe('before');
  expect(JSON.parse(text(await call('await tab.see();'))).text).toContain('Events 0');
  await reattachBrowserView();
  await evaluate(overlay,'window.requestAnimationFrame=window.originalRAF;window.originalMoveTo=window.__sofiaAgentCursor.moveTo;window.__sofiaAgentCursor.moveTo=()=>new Promise(()=>{});true');
  await reattachBrowserView();
  const hostBegan=Date.now();
  expect((await call('await tab.select({label:"Plan"},"after");')).error?.message).toContain('Agent cursor did not arrive');
  expect(Date.now()-hostBegan).toBeLessThan(6000);
  expect(text(await call('console.log(await tab.inputValue({label:"Plan"}));'))).toBe('before');
  expect(JSON.parse(text(await call('await tab.see();'))).text).toContain('Events 0');
  evidence.recordAssertionEvidence('Bounded cursor readiness', 'Actual production overlay with RAF suppressed returns animation-timeout, and a never-settling cursor move rejects within the bounded host deadline.', true);
  evidence.recordAssertionEvidence('No uncertain mutation', 'Both cursor movement failures leave the select value and input/change event count unchanged.', true);
});
