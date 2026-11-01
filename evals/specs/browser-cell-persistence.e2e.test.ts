import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { createAndSelectWorkspace, evalIn } from "@sofia/behaviors";
import { listTargets } from "@sofia/cdp";
import { desktop } from "@sofia/hosts";
import { needs, test } from "@sofia/testkit";
import { expect, onTestFinished } from "vitest";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
type Reply = { id: number; result?: { content: Array<{ type: string; text?: string }> }; error?: { message: string } };

test("Browser JavaScript cells retain local state and reset without closing the tab", { timeout: 180_000 }, async ({ evidence }) => {
  needs({ optIn: ["SOFIA_EVAL_E2E_TESTS"] });
  await using app = await desktop({ name: "browser-cell-persistence" });
  const fixture = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><title>Cell persistence fixture</title><body><h1>Persistent browser cell</h1></body>");
  });
  await new Promise<void>(resolve => fixture.listen(0, "127.0.0.1", resolve));
  onTestFinished(() => fixture.close());
  const address = fixture.address();
  if (!address || typeof address === "string") throw new Error("Fixture did not bind");
  const url = `http://127.0.0.1:${address.port}/`;
  const workspace = await createAndSelectWorkspace(app, { path: `/tmp/sofia-browser-cell-${Date.now()}` });
  await evalIn(app, `window.__SOFIA_ELECTRON__.browser.setScope(${JSON.stringify("workspace:")}+${JSON.stringify(workspace.workspaceId)})`, { awaitPromise: true });
  const opened = await evalIn(app, `window.__SOFIA_ELECTRON__.browser.openUrl(${JSON.stringify(url)}, 'builtin')`, { awaitPromise: true });
  if (!opened || typeof opened !== "object" || !("browser_url" in opened) || typeof opened.browser_url !== "string") throw new Error("Production browser broker missing");
  const broker = { baseUrl: opened.browser_url };
  let target;
  for (let attempt = 0; attempt < 60; attempt++) {
    target = (await listTargets(broker.baseUrl)).find(entry => entry.url === url);
    if (target) break;
    await sleep(150);
  }
  if (!target) throw new Error("Fixture tab missing");
  const repl = spawn(process.execPath, [fileURLToPath(new URL("../../apps/server/src/sofia-browser-repl.mjs", import.meta.url))], { env: { ...process.env, SOFIA_BROWSER_CDP_URL: broker.baseUrl }, stdio: ["pipe", "pipe", "pipe"] });
  onTestFinished(() => { repl.kill(); });
  repl.stderr.resume();
  let nextId = 1;
  let buffer = "";
  const pending = new Map<number, (reply: Reply) => void>();
  repl.stdout.on("data", chunk => {
    buffer += chunk.toString();
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const reply: Reply = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      pending.get(reply.id)?.(reply);
      pending.delete(reply.id);
    }
  });
  const call = (method: string, params: Record<string, unknown>) => new Promise<Reply>((resolve, reject) => {
    const id = nextId++;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`Browser MCP call ${id} timed out`)); }, 45_000);
    pending.set(id, reply => { clearTimeout(timeout); resolve(reply); });
    repl.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const js = async (code: string) => {
    const reply = await call("tools/call", { name: "js", arguments: { code } });
    expect(reply.error).toBeUndefined();
    return reply.result?.content.map(entry => entry.text ?? "").join("") ?? "";
  };

  const first = JSON.parse(await js(`globalThis.browser=(await setupBrowserRuntime()).browsers.get('iab');globalThis.tabId=${JSON.stringify(target.id)};globalThis.tab=await browser.tabs.get(tabId);let counter=41;const label='cell';await tab.evaluate("document.body.dataset.cell='kept'");({counter,label})`));
  expect(first).toEqual({ counter: 41, label: "cell" });
  const second = JSON.parse(await js(`counter+=1;const localLabel=label+'-two';({counter,localLabel,marker:await tab.evaluate("document.body.dataset.cell")})`));
  expect(second).toEqual({ counter: 42, localLabel: "cell-two", marker: "kept" });
  const reset = await call("tools/call", { name: "js_reset", arguments: {} });
  expect(reset.error).toBeUndefined();
  expect(reset.result?.content).toEqual([{ type: "text", text: "JavaScript session reset. Browser tabs and native apps were left open." }]);
  expect(await js("typeof counter+':' + typeof tab")).toBe("undefined:undefined");
  const reattached = await js(`globalThis.browser=(await setupBrowserRuntime()).browsers.get('iab');globalThis.tab=await browser.tabs.get(${JSON.stringify(target.id)});let counter=9;({counter,marker:await tab.evaluate("document.body.dataset.cell")})`);
  expect(JSON.parse(reattached)).toEqual({ counter: 9, marker: "kept" });

  evidence.recordAssertionEvidence("Persistent cell state", "Two production-broker cells retained a local numeric binding, a const label and the live tab handle; the page marker was readable from the second cell.", true);
  evidence.recordAssertionEvidence("Reset isolation", "js_reset removed local bindings while the exact tab remained attachable and its page marker was unchanged; a fresh local declaration then succeeded.", true);
});
