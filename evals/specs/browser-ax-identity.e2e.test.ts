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

test("Browser AX actions retain identity across duplicate names and refuse stale targets", { timeout: 180_000 }, async ({ evidence }) => {
  needs({ optIn: ["SOFIA_EVAL_E2E_TESTS"] });
  await using app = await desktop({ name: "browser-ax-identity" });
  const fixture = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<!doctype html><title>AX identity fixture</title><button id="first" onclick="window.firstClicks=(window.firstClicks||0)+1">Same name</button><button id="second" onclick="window.secondClicks=(window.secondClicks||0)+1;window.trusted=event.isTrusted">Same name</button><input aria-label="Same field" id="field1"><input aria-label="Same field" id="field2">`);
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
  const tree = JSON.parse(text(await call('await tab.ax.get();')));
  const buttons = tree.filter((node: { role: string; name: string }) => node.role === "button" && node.name === "Same name");
  const fields = tree.filter((node: { role: string; name: string }) => node.role === "textbox" && node.name === "Same field");
  expect(buttons).toHaveLength(2);
  expect(fields).toHaveLength(2);
  expect(buttons[0].ref).not.toBe(buttons[1].ref);
  text(await call(`await tab.ax.click({ref:${JSON.stringify(buttons[1].ref)}});`));
  expect(JSON.parse(text(await call('console.log(await tab.evaluate("({first:window.firstClicks||0,second:window.secondClicks||0,trusted:window.trusted})"));')))).toEqual({first:0,second:1,trusted:true});
  text(await call(`await tab.ax.setValue({ref:${JSON.stringify(fields[1].ref)},value:"second only"});`));
  expect(JSON.parse(text(await call(`console.log(await tab.evaluate(${JSON.stringify('[document.querySelector("#field1").value,document.querySelector("#field2").value]')}));`)))).toEqual(["", "second only"]);
  text(await call(`await tab.ax.typeText({ref:${JSON.stringify(fields[1].ref)},text:" appended"});`));
  expect(JSON.parse(text(await call(`console.log(await tab.evaluate(${JSON.stringify('[document.querySelector("#field1").value,document.querySelector("#field2").value]')}));`)))).toEqual(["", "second only appended"]);
  text(await call(`await tab.ax.pressKey({ref:${JSON.stringify(fields[1].ref)},combo:"Backspace"});`));
  expect(JSON.parse(text(await call(`console.log(await tab.evaluate(${JSON.stringify('[document.querySelector("#field1").value,document.querySelector("#field2").value]')}));`)))).toEqual(["", "second only appende"]);
  text(await call(`await tab.evaluate(${JSON.stringify(`document.querySelector("#second").outerHTML='<button id="replacement" onclick="window.replacementClicks=(window.replacementClicks||0)+1">Same name</button>'`)});`));
  const stale = await call(`await tab.ax.click({ref:${JSON.stringify(buttons[1].ref)}});`);
  expect(stale.error?.message).toBeTruthy();
  expect(JSON.parse(text(await call('console.log(await tab.evaluate("({first:window.firstClicks||0,second:window.secondClicks||0,replacement:window.replacementClicks||0})"));')))).toEqual({first:0,second:1,replacement:0});
  expect((await call('await tab.ax.click({ref:"unobserved"});')).error?.message).toContain('not observed');
  text(await call(`await tab.evaluate(${JSON.stringify('history.pushState({},"","/changed")')});`));
  expect((await call(`await tab.ax.click({ref:${JSON.stringify(buttons[0].ref)}});`)).error?.message).toContain('Stale AX observation');
  expect(text(await call('console.log(await tab.evaluate("window.firstClicks||0"));'))).toBe('0');
  evidence.recordAssertionEvidence('Exact AX target identity', 'Two identically named buttons and fields retain separate backend DOM identities: only the second button receives trusted input; fill/type/key operations change only the second field.', true);
  evidence.recordAssertionEvidence('Stale AX refusal', 'Replacing the observed second button cannot redirect its ref to the first or replacement button. Unknown refs and changed-document URLs reject before input.', true);
});
