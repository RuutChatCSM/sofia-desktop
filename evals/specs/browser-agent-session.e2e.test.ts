import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { createAndSelectWorkspace, evalIn } from "@sofia/behaviors";
import { connect, debuggerUrlFor, evaluate, listTargets } from "@sofia/cdp";
import { desktop } from "@sofia/hosts";
import { needs, test } from "@sofia/testkit";
import { expect, onTestFinished } from "vitest";
import { createCdpBroker } from "../../apps/desktop/electron/cdp-broker.mjs";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("connected browser shows persistent cursor and Browser activity labels", { timeout: 180_000 }, async ({ evidence }) => {
  needs({ optIn: ["SOFIA_EVAL_E2E_TESTS"] });
  await using app = await desktop({ name: "browser-agent-session" });
  const fixture = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<!doctype html><title>Agent browser</title><body><p>Read-only browser fixture</p><label for="email">Enter your email</label><input id="email" type="email"><input id="unlabelled"><input id="password" type="password" value="secret"><input id="choice" type="checkbox" aria-label="Choice"><button disabled id="disabled">Disabled</button><button id="covered" style="position:fixed;right:0;top:0;width:80px;height:40px">Covered</button><div style="position:fixed;right:0;top:0;width:80px;height:40px;z-index:10"></div><button id="double">Double</button><form onsubmit="event.preventDefault();window.entered=true"><input id="enter" aria-label="Enter test"></form><input type="hidden" value="decoy"><button onclick="window.submittedEmail=window.email">Continue</button><script>window.email='';document.querySelector('#double').addEventListener('dblclick',event=>window.doubleTrusted=event.isTrusted);window.pointerEvents=[];for(const name of ['mousedown','mouseup','click','dblclick'])document.querySelector('#double').addEventListener(name,event=>window.pointerEvents.push({name,detail:event.detail,trusted:event.isTrusted}));document.querySelector('#choice').addEventListener('change',event=>window.checkTrusted=event.isTrusted);document.querySelector('#email').addEventListener('input',event=>{window.email=event.isTrusted?event.target.value:'';event.target.value=window.email;});</script></body>`);
  });
  await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  onTestFinished(() => fixture.close());
  const address = fixture.address();
  if (!address || typeof address === "string") throw new Error('Fixture did not bind');
  await createAndSelectWorkspace(app, { path: `/tmp/sofia-browser-agent-${Date.now()}` });
  await app.client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await app.client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await evalIn(app, `window.__SOFIA_ELECTRON__.browser.openUrl("http://127.0.0.1:${address.port}/", "builtin")`, { awaitPromise: true });
  const broker = await createCdpBroker({ upstreamBaseUrl: app.handle.cdpUrl });
  onTestFinished(() => broker.close());
  let target;
  for (let attempt = 0; attempt < 60; attempt++) {
    target = (await listTargets(broker.baseUrl)).find((entry) => entry.url.startsWith(`http://127.0.0.1:${address.port}/`));
    if (target) break;
    await sleep(150);
  }
  if (!target) throw new Error('Native browser fixture missing');
  const agent = await connect(debuggerUrlFor(broker.baseUrl, target));
  const observer = await connect(debuggerUrlFor(app.handle.cdpUrl, target));
  onTestFinished(() => observer.close());
  await evaluate(agent, 'document.title');
  await sleep(250);
  const cursorState = () => evaluate(observer, `(() => { const cursor = document.querySelector('#__sofia-agent-cursor'); return cursor ? { opacity: getComputedStyle(cursor).opacity, position: cursor.style.transform } : null; })()`);
  expect((await cursorState())?.opacity).toBe('1');
  for (let attempt = 0; attempt < 40 && await evaluate(observer, 'innerWidth') < 1200; attempt++) await sleep(150);
  expect(await evaluate(observer, 'innerWidth')).toBeGreaterThanOrEqual(1200);
  const initial = await cursorState();
  await evaluate(agent, 'document.body.innerText');
  expect((await cursorState())?.position).toBe(initial?.position);
  await agent.send('Page.navigate', { url: `http://localhost:${address.port}/next` });
  await sleep(500);
  expect((await cursorState())?.opacity).toBe('1');
  expect(await evaluate(observer, 'innerWidth')).toBeGreaterThanOrEqual(1200);
  evidence.recordAssertionEvidence('Peek retains desktop layout during agent navigation', 'Native Peek has a desktop layout width before and after agent CDP navigation to a different origin.', true);
  await agent.close();
  await sleep(500);
  expect((await cursorState())?.opacity).toBe('0');
  await observer.send('Page.navigate', { url: `http://127.0.0.1:${address.port}/` });
  await sleep(500);
  expect(await cursorState()).toBe(null);
  const sentence = await evalIn(app, `(async () => {
    const { codexItemToToolPart } = await import('/src/react-app/domains/session/sync/codex-item-translator.ts');
    const { getCapabilityCallSentence } = await import('/src/lib/capability-call.ts');
    const part = codexItemToToolPart({ id: 'browser-label', type: 'mcpToolCall', server: 'node_repl', tool: 'js', status: 'completed', arguments: { code: 'await tab.see()' } }, 'session', 'message');
    return getCapabilityCallSentence(part);
  })()`, { awaitPromise: true });
  expect(sentence.past).toBe('Used Browser');
  expect(sentence.present).toBe('Using Browser');
  evidence.recordAssertionEvidence('Browser connection cursor and tool identity', 'Read-only connection shows the cursor without moving it; navigation retains visibility; disconnect hides it and removes its navigation script. Browser MCP activity has Browser labels.', true);

  await app.client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await app.client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await evalIn(app, `document.querySelector('button[aria-label="Browser"]')?.click()`);
  await evalIn(app, `window.__SOFIA_ELECTRON__.browser.setPresentation('docked')`, { awaitPromise: true });
  await sleep(500);
  const repl = spawn(process.execPath, [fileURLToPath(new URL('../../apps/server/src/sofia-browser-repl.mjs', import.meta.url))], { env: { ...process.env, SOFIA_BROWSER_CDP_URL: broker.baseUrl }, stdio: ['pipe', 'pipe', 'pipe'] });
  onTestFinished(() => { repl.kill(); });
  repl.stderr.resume();
  const result = await new Promise<string>((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error('Browser fill MCP timed out')), 60_000);
    repl.stdout.on('data', (chunk) => {
      output += chunk.toString();
      if (output.includes('\n')) { clearTimeout(timeout); resolve(output.trim()); }
    });
    repl.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'js', arguments: { code: `
      const browser = (await setupBrowserRuntime()).browsers.get('iab');
      const tab = await browser.tabs.get(${JSON.stringify(target.id)});
      const before = await tab.see();
      console.log(JSON.stringify({ fields: before.elements.filter(e => e.role === 'textbox') }));
      await tab.fill({ role: 'textbox' }, 'first@example.test');
      await tab.fill({ label: 'Enter your email' }, 'second@example.test');
      let rejected = false;
      try { await tab.fill({ role: 'button' }, 'invalid'); } catch { rejected = true; }
      console.log(JSON.stringify({ rejected }));
      console.log(JSON.stringify({ value: await tab.inputValue({label:'Enter your email'}), after: (await tab.see()).elements }));
      await tab.fill({label:'Enter your email'}, 'second@example.test');
      await tab.type({text:'.extra'});
      console.log(JSON.stringify({ typed: await tab.inputValue({label:'Enter your email'}) }));
      await tab.fill({label:'Enter your email'}, 'second@example.test');
      await tab.check({label:'Choice'});
      await tab.check({label:'Choice'});
      await tab.hover({selector:'#double'});
      await tab.dblclick({selector:'#double'});
      await tab.press({label:'Enter test'}, 'Enter');
      let disabledRejected=false,coveredRejected=false;
      try { await tab.click({selector:'#disabled'}); } catch { disabledRejected=true; }
      try { await tab.click({selector:'#covered'}); } catch { coveredRejected=true; }
      console.log(JSON.stringify({disabledRejected,coveredRejected}));

    ` } } }) + '\n');
  });
  expect(result).toContain('Enter your email');
  const response = JSON.parse(result);
  const content = response.result.content.map((entry: { text?: string }) => entry.text ?? '').join('');
  const fields = JSON.parse(response.result.content[0].text).fields;
  expect(fields).toHaveLength(4);
  expect(content).not.toContain('secret');
  expect(content).toContain('second@example.test.extra');
  expect(content).toContain('\"disabledRejected\":true');
  expect(content).toContain('\"coveredRejected\":true');
  expect(content).toContain('\"valid\":true');
  expect(await evaluate(observer, 'window.checkTrusted'), JSON.stringify(await evaluate(observer, '({width:innerWidth,dpr:devicePixelRatio,events:window.pointerEvents})'))).toBe(true);
  expect(await evaluate(observer, "document.querySelector('#choice').checked")).toBe(true);
  expect(await evaluate(observer, 'window.doubleTrusted'), JSON.stringify(await evaluate(observer, 'window.pointerEvents'))).toBe(true);
  expect(await evaluate(observer, 'window.entered')).toBe(true);
  expect(content).toContain('"rejected":true');
  expect(await evaluate(observer, "document.querySelector('#email').value")).toBe('second@example.test');
  expect(await evaluate(observer, 'window.email')).toBe('second@example.test');
  evidence.recordAssertionEvidence('Browser fills the visible labelled input', 'Real Browser MCP reads non-password field values and validity, fills and types using trusted events, checks idempotently, dispatches trusted double-click and Enter submission, and rejects noneditable, disabled and covered targets.', true);

  repl.kill();
  const resumed = spawn(process.execPath, [fileURLToPath(new URL('../../apps/server/src/sofia-browser-repl.mjs', import.meta.url))], { env: { ...process.env, SOFIA_BROWSER_CDP_URL: broker.baseUrl }, stdio: ['pipe', 'pipe', 'pipe'] });
  onTestFinished(() => { resumed.kill(); });
  resumed.stderr.resume();
  const resumedResult = await new Promise<string>((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error('Browser resume MCP timed out')), 40_000);
    resumed.stdout.on('data', (chunk) => {
      output += chunk.toString();
      if (output.includes('\n')) { clearTimeout(timeout); resolve(output.trim()); }
    });
    resumed.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'js', arguments: { code: `
      globalThis.iab = (await setupBrowserRuntime()).browsers.get('iab');
      const listed = await iab.tabs.list();
      console.log(JSON.stringify(listed));
      globalThis.tab = await iab.tabs.get(${JSON.stringify(target.id)});
      const attached = await iab.tabs.attach(tab.id);
      const snapshot = await attached.see();
      const button = snapshot.elements.find(e => e.role === 'button' && e.label === 'Continue');
      await attached.click({ index: button.index });
      console.log('resumed');
    ` } } }) + '\n');
  });
  const resumedResponse = JSON.parse(resumedResult);
  expect(resumedResponse.error).toBeUndefined();
  const listed = JSON.parse(resumedResponse.result.content[0].text);
  expect(listed.find((entry: { id: string }) => entry.id === target.id)).toMatchObject({ url: `http://127.0.0.1:${address.port}/`, title: 'Agent browser' });
  expect(await evaluate(observer, 'window.submittedEmail')).toBe('second@example.test');
  expect((await listTargets(broker.baseUrl)).filter(entry => entry.url.startsWith(`http://127.0.0.1:${address.port}/`))).toHaveLength(1);
  evidence.recordAssertionEvidence('Browser resumes the same form after its MCP process restarts', 'A fresh Browser MCP lists URL/title metadata, gets and attaches the original tab by ID, then clicks Continue with the preserved email. Exactly one fixture tab remains.', true);

});
