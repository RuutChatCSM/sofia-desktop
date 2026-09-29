import { execFile, spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expect } from "vitest";
import { needs, test, eventually } from "@sofia/testkit";
const run = promisify(execFile);

test.skipIf(process.platform !== "darwin")("connecting Computer Use exposes Electron controls through the native AX bridge", { timeout: 90_000 }, async ({ evidence }) => {
  needs({ optIn: ["SOFIA_EVAL_E2E_TESTS", "SOFIA_LIVE_DESKTOP_TESTS"] });
  let electron: ReturnType<typeof spawn> | undefined;
  const root = await mkdtemp(join(tmpdir(), "sofia-native-ax-"));
  try {
    const moduleUrl = pathToFileURL(resolve(import.meta.dirname, "../../apps/desktop/electron/computer-use.mjs")).href;
    const script = join(root, "probe.mjs");
    const resultFile = join(root, "result.json");
    await writeFile(script, `
      import { app, BrowserWindow } from 'electron';
      import { execFile, spawn } from 'node:child_process';
      import { writeFile } from 'node:fs/promises';
      import { getComputerUseMcpCommand } from ${JSON.stringify(moduleUrl)};
      app.setName('Sofia AX Test');
      app.setPath('userData', ${JSON.stringify(join(root, "profile"))});
      app.whenReady().then(async () => {
      app.setAccessibilitySupportEnabled(false);
      const before = app.accessibilitySupportEnabled;
      const command = getComputerUseMcpCommand();
      const enabled = app.accessibilitySupportEnabled;
      const window = new BrowserWindow({width:600,height:300});
      await window.loadURL('data:text/html,<title>Sofia AX Test</title><button aria-label="Verify permissions">Verify permissions</button><input aria-label="Test input" value="AX fixture">');
      await new Promise(r=>setTimeout(r,500));
      await writeFile(${JSON.stringify(resultFile)},JSON.stringify({before,enabled,pid:process.pid}));
      });
    `);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    electron = spawn(resolve(import.meta.dirname, "../../apps/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"), [script], { env, stdio: "ignore" });
    const result = await eventually(async () => JSON.parse(await readFile(resultFile, "utf8")), { within: 15_000 });
    expect(result.before).toBe(false);
    expect(result.enabled).toBe(true);
    const profile = process.env.SOFIA_LIVE_DESKTOP_PROFILE;
    if (!profile) throw new Error("needs: SOFIA_LIVE_DESKTOP_PROFILE pointing to the trusted running dev app profile");
    const { credentials } = JSON.parse(await readFile(join(profile, "sofia-server-tokens.json"), "utf8"));
    const baseUrl = process.env.SOFIA_LIVE_DESKTOP_URL;
    if (!baseUrl) throw new Error("needs: SOFIA_LIVE_DESKTOP_URL");
    const workspaceId = process.env.SOFIA_LIVE_WORKSPACE_ID;
    if (!workspaceId) throw new Error("needs: SOFIA_LIVE_WORKSPACE_ID");
    const response = await fetch(`${baseUrl}/workspace/${workspaceId}/sessions`, {
      method: "POST", headers: { Authorization: `Bearer ${credentials.clientToken}`, "content-type": "application/json" },
      body: JSON.stringify({ title: "Native Electron accessibility regression", providerId: "openrouter", modelId: "stealth/space-bunny-alpha",
        prompt: `Use only computer-use MCP: snapshot pid ${result.pid}, window Sofia AX Test; then snapshot_elements with that snapshot_id and query Verify permissions; then snapshot_elements with the same snapshot_id and query Test input. Return the observations. Do not use shell, Browser, or mutate anything.` }),
    });
    expect(response.status).toBe(201);
    const session = await response.json();
    const thread = session.item.id.replace(/^codex-/, "");
    const { stdout } = await run("python3", ["-c", "import sqlite3,sys; c=sqlite3.connect('file:' + sys.argv[2] + '?mode=ro',uri=True);print(c.execute('select rollout_path from threads where id=?',(sys.argv[1],)).fetchone()[0])", thread, join(homedir(), ".sofia/state_5.sqlite")]);
    const events = await eventually(async () => {
      const entries = (await readFile(stdout.trim(), "utf8")).trim().split("\n").map(line => JSON.parse(line).payload);
      if (!entries.some(entry => entry?.type === "task_complete")) throw new Error("Native snapshot turn still running");
      return entries;
    }, { within: 60_000 });
    const calls = events.filter(entry => entry?.type === "function_call");
    expect(calls.map(call => call.name)).toEqual(["snapshot", "snapshot_elements", "snapshot_elements"]);
    expect(JSON.parse(calls[0].arguments).pid).toBe(result.pid);
    const payloads = calls.slice(1).map(call => {
      const output = events.find(entry => entry?.type === "function_call_output" && entry.call_id === call.call_id).output;
      return JSON.parse(output.find((block: {text?:string}) => block.text?.startsWith("{")).text);
    });
    for (const payload of payloads) expect(payload.ok, payload.error).toBe(true);
    expect(payloads[0].elements.some((element: {label:string}) => element.label === "Verify permissions")).toBe(true);
    expect(payloads[1].elements.some((element: {label:string}) => element.label === "Test input")).toBe(true);
    evidence.recordAssertionEvidence("Electron controls appear in the native Computer Use snapshot", "After connecting from an explicitly disabled state, macOS AX reports the named button and text input rather than just window chrome.", true);
  } finally { electron?.kill(); await rm(root, { recursive:true,force:true }); }
});
