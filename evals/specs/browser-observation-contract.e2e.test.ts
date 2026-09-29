import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { createAndSelectWorkspace, evalIn } from "@sofia/behaviors";
import { listTargets } from "@sofia/cdp";
import { desktop } from "@sofia/hosts";
import { needs, test } from "@sofia/testkit";
import { expect, onTestFinished } from "vitest";
import { createCdpBroker } from "../../apps/desktop/electron/cdp-broker.mjs";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
type Reply = { id: number; result?: { content: Array<{ type: string; text?: string; data?: string }> }; error?: { message: string } };

test("Browser observations expose text, inert email frames, metadata and truthful errors", { timeout: 180_000 }, async ({ evidence }) => {
  needs({ optIn: ["SOFIA_EVAL_E2E_TESTS"] });
  await using app = await desktop({ name: "browser-observation-contract" });
  const fixture = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    if (request.url === "/opaque") { response.end("<!doctype html><body>Opaque child</body>"); return; }
    response.end(`<!doctype html><title>Observation fixture</title><body><p>Readable message header</p><input type="password" value="do-not-expose"><iframe title="Message body" sandbox srcdoc="&lt;script&gt;parent.executed=true&lt;/script&gt;&lt;style&gt;.secret {color:red}&lt;/style&gt;&lt;p&gt;Invitation body inside sandbox&lt;/p&gt;&lt;a href='/invitation'&gt;Accept invitation&lt;/a&gt;"></iframe><iframe title="Opaque frame" sandbox src="/opaque"></iframe></body>`);
  });
  await new Promise<void>(resolve => fixture.listen(0, "127.0.0.1", resolve));
  onTestFinished(() => fixture.close());
  const address = fixture.address();
  if (!address || typeof address === 'string') throw new Error('Fixture did not bind');
  const url = `http://127.0.0.1:${address.port}/`;
  await createAndSelectWorkspace(app, { path: `/tmp/sofia-browser-observation-${Date.now()}` });
  await app.client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await app.client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await evalIn(app, `window.__SOFIA_ELECTRON__.browser.openUrl(${JSON.stringify(url)}, 'builtin')`, { awaitPromise: true });
  const broker = await createCdpBroker({ upstreamBaseUrl: app.handle.cdpUrl });
  onTestFinished(() => broker.close());
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
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`Browser MCP call ${id} timed out`)); }, 20_000);
    pending.set(id, reply => { clearTimeout(timeout); resolve(reply); });
    repl.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'js', arguments: { code } } }) + '\n');
  });
  const text = (reply: Reply) => {
    expect(reply.error).toBeUndefined();
    return reply.result?.content.map(entry => entry.text ?? '').join('') ?? '';
  };
  text(await call(`globalThis.browser=(await setupBrowserRuntime()).browsers.get('iab');globalThis.tabId=${JSON.stringify(target.id)};globalThis.tab=await browser.tabs.get(tabId);`));
  const listing = JSON.parse(text(await call('await browser.tabs.list();')));
  expect(listing.find((entry: { id: string }) => entry.id === target.id)).toEqual({ id: target.id, url, title: 'Observation fixture' });
  const seen = JSON.parse(text(await call('await tab.see();')));
  expect(seen.text).toContain('Readable message header');
  expect(seen.text).not.toContain('Invitation body inside sandbox');
  expect(seen.frames).toHaveLength(2);
  expect(seen.frames[0]).toMatchObject({ title: 'Message body', hasSrcdoc: true, readable: false });
  expect(JSON.stringify(seen)).not.toContain('do-not-expose');
  const short = JSON.parse(text(await call('await tab.see({maxText:5});')));
  expect(short.text).toBe('Reada');
  expect(short.textTruncated).toBe(true);
  const without = JSON.parse(text(await call('await tab.see({includeText:false});')));
  expect(without.text).toBe('');
  expect((await call('await tab.see({unknown:true});')).error?.message).toContain('Unsupported observation option');
  expect((await call('await tab.evaluate(()=>document.title);')).error?.message).toContain('expects a JavaScript string');
  expect((await call('await tab.evaluate({expression:"document.title"});')).error?.message).toContain('expects a JavaScript string');
  expect((await call('await tab.evaluate("throw new Error(\\\"page failed\\\")");')).error?.message).toContain('page failed');
  expect(text(await call('console.log(await tab.evaluate("document.title"));'))).toBe('Observation fixture');
  const frame = JSON.parse(text(await call('await tab.frames.read({index:0});')));
  expect(frame.source).toBe('srcdoc');
  expect(frame.text).toBe('Invitation body inside sandboxAccept invitation');
  expect(frame.links).toEqual([{ text: 'Accept invitation', href: `${url}invitation` }]);
  expect(frame.text).not.toContain('parent.executed');
  expect(frame.text).not.toContain('color:red');
  expect(text(await call('console.log(await tab.evaluate("window.executed===true"));'))).toBe('false');
  expect((await call('await tab.frames.read({index:1});')).error?.message).toContain('without srcdoc');
  expect((await call('await tab.frames.read({index:99});')).error?.message).toContain('Frame not found');
  text(await call('delete globalThis.tab;globalThis.tab=await browser.tabs.get(tabId);'));
  expect(text(await call('console.log(await tab.url());'))).toBe(url);
  expect((await listTargets(broker.baseUrl)).filter(entry => entry.url === url)).toHaveLength(1);
  // Bare observations are returned; explicitly printed ones aren't duplicated.
  expect((await call('console.log(await tab.see());')).result?.content).toHaveLength(1);
  const screenshot = await call('await tab.screenshot();');
  expect(screenshot.error).toBeUndefined();
  expect(screenshot.result?.content[0].type).toBe('image');
  expect(screenshot.result?.content[0].data?.length).toBeGreaterThan(100);
  evidence.recordAssertionEvidence('Observation and error contract', 'Actual stdio MCP returns bare reads/screenshots, bounded page text and plain tab metadata; rejects unsupported options/evaluate argument shapes; propagates page exceptions; reads sandboxed srcdoc inertly without executing scripts; refuses opaque frames; reattaches exact tab without a duplicate.', true);
});
