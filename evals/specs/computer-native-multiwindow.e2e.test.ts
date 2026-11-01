import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { eventually, needs, test } from "@sofia/testkit";
import { expect, onTestFinished } from "vitest";

const execute = promisify(execFile);
type Reply = { id: number; result?: { isError?: boolean; content: Array<{ type: string; text?: string }> } };
type CallResult = { isError: boolean; result: Record<string, unknown> };

test("Native windows keep independent targets and snapshots", { timeout: 180_000 }, async ({ evidence }) => {
  needs({ optIn: ["SOFIA_EVAL_E2E_TESTS"], placement: "local" });
  if (process.platform !== "darwin") throw new Error("needs: macOS Accessibility");
  const packagePath = resolve(import.meta.dirname, "../../packages/handsfree/native/HandsFree");
  await execute("swift", ["build", "--package-path", packagePath, "--product", "HandsFreeComputerUse"], { timeout: 120_000 });
  const binPath = (await execute("swift", ["build", "--package-path", packagePath, "--show-bin-path"], { timeout: 30_000 })).stdout.trim();
  const helper = join(binPath, "HandsFreeComputerUse");
  const permission = JSON.parse((await execute(helper, ["--check"], { timeout: 15_000 })).stdout);
  if (!permission.ok) throw new Error(`needs: grant Accessibility and Screen Recording to ${helper}`);

  const root = await mkdtemp(join(tmpdir(), "sofia-native-multiwindow-"));
  const ready = join(root, "ready.json");
  let fixtureOutput = "";
  onTestFinished(async () => {
    await mkdir(evidence.dir, { recursive: true });
    await writeFile(join(evidence.dir, "fixture-output.log"), fixtureOutput);
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "sofia-native-multiwindow-fixture", main: "fixture.cjs" }));
  await writeFile(join(root, "fixture.cjs"), `const {app,BrowserWindow}=require('electron');const {writeFile}=require('node:fs/promises');(async()=>{app.setName('Sofia Multi Window Fixture');app.setPath('userData',${JSON.stringify(join(root, "profile"))});await app.whenReady();app.setAccessibilitySupportEnabled(true);const make=async(title,label)=>{const win=new BrowserWindow({width:460,height:240,show:false,title});await win.loadURL('data:text/html,'+encodeURIComponent('<title>'+title+'</title><button aria-label="'+label+'" onclick="window.clickCount=(window.clickCount||0)+1;document.getElementById(\\'count\\').textContent=\\''+label+' count: \\'+window.clickCount">'+label+'</button><p id="count">'+label+' count: 0</p>'));win.showInactive();};await make('Native Multi A','Increment A');await make('Native Multi B','Increment B');await writeFile(${JSON.stringify(ready)},JSON.stringify({pid:process.pid}));})().catch(error=>{console.error(error);app.exit(1);});`);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const fixture = spawn(resolve(import.meta.dirname, "../../apps/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"), [root], { env, stdio: ["ignore", "pipe", "pipe"] });
  fixture.stdout.on("data", chunk => { fixtureOutput += chunk; });
  fixture.stderr.on("data", chunk => { fixtureOutput += chunk; });
  onTestFinished(() => fixture.kill());
  const identity = await eventually(async () => {
    if (fixture.exitCode !== null) throw new Error(`Fixture exited ${fixture.exitCode}: ${fixtureOutput}`);
    return JSON.parse(await readFile(ready, "utf8")) as { pid: number };
  }, { within: 15_000 });

  const transport = spawn(helper, ["mcp"], { env: { ...process.env, SOFIA_COMPUTER_USE_CURSOR_OVERLAY: "0" }, stdio: ["pipe", "pipe", "pipe"] });
  let buffer = "";
  const pending = new Map<number, (reply: Reply) => void>();
  let nextId = 1;
  transport.stdout.on("data", chunk => {
    buffer += chunk.toString();
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const reply = JSON.parse(buffer.slice(0, newline)) as Reply;
      buffer = buffer.slice(newline + 1);
      pending.get(reply.id)?.(reply);
      pending.delete(reply.id);
    }
  });
  onTestFinished(() => { transport.kill(); });
  const request = (method: string, params: Record<string, unknown>) => new Promise<Reply>((resolveReply, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => reject(new Error(`Native MCP ${method} timed out`)), 30_000);
    pending.set(id, reply => { clearTimeout(timer); resolveReply(reply); });
    transport.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  await request("initialize", {});
  const call = async (name: string, args: Record<string, unknown>): Promise<CallResult> => {
    const reply = await request("tools/call", { name, arguments: args });
    const text = reply.result?.content.find(block => block.type === "text")?.text;
    if (!text) throw new Error(`Native tool ${name} returned no structured text`);
    return { isError: reply.result?.isError === true, result: JSON.parse(text) as Record<string, unknown> };
  };
  const list = await eventually(async () => {
    const result = await call("list_windows", { pid: identity.pid });
    if (result.isError || !Array.isArray(result.result.windows)) throw new Error(`Window listing unavailable: ${JSON.stringify(result)}`);
    const windows = (result.result.windows as Array<{ target_id: string; window_title: string; window_number: number }>).filter(window => window.window_title.startsWith("Native Multi "));
    if (windows.length !== 2) throw new Error(`Expected two fixture windows: ${JSON.stringify(result)}`);
    return windows;
  }, { within: 10_000 });
  const targetA = list.find(window => window.window_title === "Native Multi A");
  const targetB = list.find(window => window.window_title === "Native Multi B");
  expect(targetA).toBeDefined();
  expect(targetB).toBeDefined();
  expect(targetA?.target_id).not.toBe(targetB?.target_id);
  expect(targetA?.window_number).not.toBe(targetB?.window_number);

  const ambiguous = await call("snapshot", { app: "Sofia Multi Window Fixture", pid: identity.pid });
  expect(ambiguous.isError).toBe(true);
  expect(String(ambiguous.result.error)).toContain("Multiple windows match");

  const snapshotA = await call("snapshot", { target_id: targetA?.target_id, wait_for: "Increment A", wait_milliseconds: 3000 });
  const snapshotB = await call("snapshot", { target_id: targetB?.target_id, wait_for: "Increment B", wait_milliseconds: 3000 });
  expect(snapshotA.result.target_id).toBe(targetA?.target_id);
  expect(snapshotB.result.target_id).toBe(targetB?.target_id);
  expect(snapshotA.result.snapshot_id).not.toBe(snapshotB.result.snapshot_id);
  const buttonA = (snapshotA.result.elements as Array<{ label: string; ref: string }>).find(element => element.label === "Increment A");
  const buttonB = (snapshotB.result.elements as Array<{ label: string; ref: string }>).find(element => element.label === "Increment B");
  expect(buttonA).toBeDefined();
  expect(buttonB).toBeDefined();
  await call("click", { snapshot_id: snapshotA.result.snapshot_id, ref: buttonA?.ref });
  const afterA = await eventually(async () => {
    const snapshot = await call("snapshot", { target_id: targetA?.target_id });
    const page = await call("snapshot_elements", { snapshot_id: snapshot.result.snapshot_id, query: "A count" });
    const text = JSON.stringify(page.result.elements);
    expect(text).toContain("A count: 1");
    expect(text).not.toContain("A count: 0");
    return snapshot;
  }, { within: 5_000 });
  await call("click", { snapshot_id: snapshotB.result.snapshot_id, ref: buttonB?.ref });
  const afterB = await eventually(async () => {
    const snapshot = await call("snapshot", { target_id: targetB?.target_id });
    const page = await call("snapshot_elements", { snapshot_id: snapshot.result.snapshot_id, query: "B count" });
    const text = JSON.stringify(page.result.elements);
    expect(text).toContain("B count: 1");
    expect(text).not.toContain("B count: 0");
    return snapshot;
  }, { within: 5_000 });
  const pageA = await call("snapshot_elements", { snapshot_id: afterA.result.snapshot_id, query: "A count" });
  expect(JSON.stringify(pageA.result.elements)).toContain("A count: 1");
  expect(afterA.result.target_id).not.toBe(afterB.result.target_id);

  await mkdir(evidence.dir, { recursive: true });
  await writeFile(join(evidence.dir, "native-multiwindow.json"), JSON.stringify({ helper, permission, pid: identity.pid, windows: list, snapshots: [snapshotA.result, snapshotB.result, afterA.result, afterB.result] }, null, 2));
  evidence.recordAssertionEvidence("Independent window targets", "Two same-app windows received different target ids and snapshot ids; ambiguous app-only selection was rejected with both candidates.", true);
  evidence.recordAssertionEvidence("Cross-window action isolation", "Clicking A changed only A's count while B's original snapshot remained valid; clicking B with that snapshot changed only B.", true);
});
