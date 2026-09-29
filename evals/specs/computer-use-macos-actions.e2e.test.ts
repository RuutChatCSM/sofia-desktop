import { execFile, spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expect } from "vitest";
import { needs, test, eventually } from "@sofia/testkit";
const run = promisify(execFile);

test.skipIf(process.platform !== "darwin")("macOS Computer Use sends Unicode and balanced keys, opens context menus, and captures zoomed regions", { timeout: 240_000 }, async ({ evidence }) => {
  needs({ optIn: ["SOFIA_EVAL_E2E_TESTS", "SOFIA_LIVE_DESKTOP_TESTS"] });
  let electron: ReturnType<typeof spawn> | undefined;
  const root = await mkdtemp(join(tmpdir(), "sofia-native-ax-"));
  try {
    const moduleUrl = pathToFileURL(resolve(import.meta.dirname, "../../apps/desktop/electron/computer-use.mjs")).href;
    const script = join(root, "probe.mjs");
    const resultFile = join(root, "result.json");
    const stateFile = join(root, "state.json");
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
      await window.loadURL('data:text/html,<title>Sofia AX Test</title><button aria-label="Verify permissions">Verify permissions</button><input aria-label="Test input" value=""><script>window.events=[];document.addEventListener("keydown",e=>events.push({type:e.type,key:e.key,t:performance.now()}));document.addEventListener("keyup",e=>events.push({type:e.type,key:e.key,t:performance.now()}));document.addEventListener("contextmenu",e=>{e.preventDefault();events.push({type:e.type})})</script>');
      await new Promise(r=>setTimeout(r,500));
      await writeFile(${JSON.stringify(resultFile)},JSON.stringify({before,enabled,pid:process.pid}));
      setInterval(async () => { const state = await window.webContents.executeJavaScript('JSON.stringify({value:document.querySelector("input").value,events:window.events})'); await writeFile(${JSON.stringify(stateFile)},state); },100);
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
        prompt: `Use only computer-use MCP on pid ${result.pid}, window Sofia AX Test. Take snapshot then snapshot_elements query Test input to find ref. Click the input and type_text exactly "aaaaaaaaaaaaaaaaaaa😀日本語" (19 a characters then emoji and Japanese). Do not use set_value, clipboard, shell or Browser. Fresh snapshot after each action. Next click the Verify permissions button with button right to trigger contextmenu. Next click the input again and press_key combo a with milliseconds 300. Take fresh snapshot after each. Finally take a cropped snapshot of the top-left 200 by 100 screen points of this window using its capturedBounds origin and image_width 512. Return observations. Only mutate this fixture.` }),
    });
    expect(response.status).toBe(201);
    const session = await response.json();
    const thread = session.item.id.replace(/^codex-/, "");
    const { stdout } = await run("python3", ["-c", "import sqlite3,sys; c=sqlite3.connect('file:' + sys.argv[2] + '?mode=ro',uri=True);print(c.execute('select rollout_path from threads where id=?',(sys.argv[1],)).fetchone()[0])", thread, join(homedir(), ".sofia/state_5.sqlite")]);
    const events = await eventually(async () => {
      const entries = (await readFile(stdout.trim(), "utf8")).trim().split("\n").map(line => JSON.parse(line).payload);
      if (!entries.some(entry => entry?.type === "task_complete")) throw new Error("Native snapshot turn still running");
      return entries;
    }, { within: 140_000 });
    const calls = events.filter(entry => entry?.type === "function_call");
    expect(calls.length).toBeGreaterThan(5);
    expect(calls.every(call => ["snapshot", "snapshot_elements", "click", "type_text", "press_key", "wait"].includes(call.name))).toBe(true);
    expect(JSON.parse(calls[0].arguments).pid).toBe(result.pid);
    expect(calls.some(call => call.name === "click" && JSON.parse(call.arguments).button === "right")).toBe(true);
    expect(calls.some(call => call.name === "press_key" && JSON.parse(call.arguments).milliseconds === 300)).toBe(true);
    const cropCall = calls.find(call => call.name === "snapshot" && JSON.parse(call.arguments).crop);
    expect(cropCall).toBeDefined();
    const output = events.find(entry => entry?.type === "function_call_output" && entry.call_id === cropCall.call_id).output;
    const cropResult = JSON.parse(output.find((block: {text?:string}) => block.text?.startsWith("{")).text);
    expect(cropResult.ok).toBe(true);
    expect(cropResult.screenshot.imageWidth).toBeGreaterThan(0);
    expect(cropResult.screenshot.capturedBounds.width).toBe(200);
    expect(cropResult.screenshot.capturedBounds.height).toBe(100);
    const state = await eventually(async () => JSON.parse(await readFile(stateFile,"utf8")), { within: 2000 });
    expect(state.value).toBe("aaaaaaaaaaaaaaaaaaa😀日本語a");
    expect(state.events.some((event: {type:string}) => event.type === "contextmenu")).toBe(true);
    const down = state.events.findLast((event: {type:string,key:string}) => event.type === "keydown" && event.key === "a");
    const up = state.events.findLast((event: {type:string,key:string}) => event.type === "keyup" && event.key === "a");
    expect(up.t - down.t).toBeGreaterThanOrEqual(250);
    expect(state.events.filter((event: {type:string})=>event.type==="keydown").length).toBe(state.events.filter((event: {type:string})=>event.type==="keyup").length);
    // A new session starts a new native helper. Old observations must fail,
    // but recovery must re-observe the same running fixture, not launch another.
    const recoveryResponse = await fetch(`${baseUrl}/workspace/${workspaceId}/sessions`, {
      method: "POST", headers: { Authorization: `Bearer ${credentials.clientToken}`, "content-type": "application/json" },
      body: JSON.stringify({title:"Computer Use reconnect regression", providerId:"openrouter", modelId:"stealth/space-bunny-alpha",
        prompt:`Use only computer-use MCP. First call snapshot_elements snapshot_id ${cropResult.snapshot_id}. The helper is new so this should fail. Recover by snapshot pid ${result.pid} window_title Sofia AX Test wait_for Test input wait_milliseconds 2000, then snapshot_elements with the new snapshot_id query Test input. Do not launch, activate, type, click, or use shell or Browser.`}),
    });
    expect(recoveryResponse.status).toBe(201);
    const recoveredSession = await recoveryResponse.json();
    const recoveryThread = recoveredSession.item.id.replace(/^codex-/u, "");
    const recoveredPath = await run("python3", ["-c", "import sqlite3,sys; c=sqlite3.connect('file:' + sys.argv[2] + '?mode=ro',uri=True);print(c.execute('select rollout_path from threads where id=?',(sys.argv[1],)).fetchone()[0])", recoveryThread, join(homedir(), ".sofia/state_5.sqlite")]);
    const recoveredEvents = await eventually(async () => {
      const entries = (await readFile(recoveredPath.stdout.trim(),"utf8")).trim().split("\n").map(line=>JSON.parse(line).payload);
      if (!entries.some(entry=>entry?.type === "task_complete")) throw new Error("Recovery still running");
      return entries;
    },{within:60_000});
    const recoveredCalls = recoveredEvents.filter(entry=>entry?.type === "function_call");
    expect(recoveredCalls.map(call=>call.name)).toEqual(["snapshot_elements","snapshot","snapshot_elements"]);
    expect(JSON.parse(recoveredCalls[1].arguments).pid).toBe(result.pid);
    const recoveredOutputs = recoveredCalls.map(call=> {
      const output = recoveredEvents.find(entry=>entry?.type==="function_call_output" && entry.call_id===call.call_id).output;
      return JSON.parse(output.find((block:{text?:string})=>block.text?.startsWith("{")).text);
    });
    expect(recoveredOutputs[0].ok).toBe(false);
    expect(recoveredOutputs[0].requiredNextAction).toBe("snapshot");
    expect(recoveredOutputs[1].ok).toBe(true);
    expect(recoveredOutputs[2].elements.some((element:{value?:string})=>element.value==="aaaaaaaaaaaaaaaaaaa😀日本語a")).toBe(true);
    evidence.recordAssertionEvidence("Native macOS input reaches only the fixture", "Fixture DOM verifies Unicode content, context-menu events and balanced held keys; a cropped snapshot returns mapped dimensions.", true);
  } finally { electron?.kill(); await rm(root, { recursive:true,force:true }); }
});
