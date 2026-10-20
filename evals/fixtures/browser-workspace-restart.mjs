// Runs the real browser-panel factory in an isolated Electron process/profile.
import { app, BrowserWindow, session, webContents } from "electron";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import { createBrowserPanel } from "../../apps/desktop/electron/browser-panel.mjs";

const [profile, stage, base, report] = process.argv.slice(2);
app.setPath("userData", profile);
app.commandLine.appendSwitch("no-first-run");
app.commandLine.appendSwitch("disable-gpu");
const pause = () => new Promise(resolve => setTimeout(resolve, 40));
async function until(read, test) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const value = await read();
    if (test(value)) return value;
    await pause();
  }
  throw new Error("Browser restore fixture timed out");
}
let win;
let panel;
async function run() {
try {
  await app.whenReady();
  win = new BrowserWindow({ width: 1280, height: 900, frame: false, show: false, webPreferences: { sandbox: true } });
  await win.loadURL('data:text/html,<body style="margin:0;background:rgb(32,59,67)"></body>');
  const activations = [];
  const send = win.webContents.send.bind(win.webContents);
  win.webContents.send = (channel, ...args) => {
    if (channel === "sofia:browser:tab-activated") activations.push(args[0]);
    return send(channel, ...args);
  };
  panel = createBrowserPanel({ getWindow: () => win, remoteDebugPort: 0 });
  win.on("close", () => panel.prepareForWindowClose());
  win.on("closed", () => panel.destroy());
  const handlers = new Map();
  panel.registerIpc({ handle: (key, handler) => handlers.set(key, handler), on: () => {} });
  const invoke = (name, ...args) => handlers.get(`sofia:browser:${name}`)({ sender: win.webContents }, ...args);
  const state = () => invoke("state");
  let result;
  if (stage === "create") {
    invoke("setScope", "session:A");
    const first = invoke("createTab", `${base}/first`).tabId;
    await until(state, s => s.tabs.find(tab => tab.id === first)?.url === `${base}/first` && s.tabs.find(tab => tab.id === first)?.pageState.status === "ready");
    const page = webContents.getAllWebContents().find(contents => contents.getURL() === `${base}/first`);
    await page.executeJavaScript("localStorage.setItem('restoration-proof', 'survived')");
    await page.loadURL(`${base}/second`);
    const second = invoke("createTab", `${base}/background`).tabId;
    await until(state, s => s.tabs.find(tab => tab.id === second)?.url === `${base}/background` && s.tabs.find(tab => tab.id === second)?.pageState.status === "ready");
    invoke("reorderTabs", [second, first]);
    invoke("selectTab", first);
    invoke("setScope", "session:B");
    const other = invoke("createTab", `${base}/other`).tabId;
    await until(state, s => s.tabs.find(tab => tab.id === other)?.url === `${base}/other` && s.tabs.find(tab => tab.id === other)?.pageState.status === "ready");
    invoke("setScope", "session:A");
    invoke("reorderTabs", [second, first]);
    const frames = [];
    for (const presentation of ["docked", "expanded"]) {
      invoke("setPresentation", presentation);
      invoke("show", { x: 400, y: 130, width: 600, height: 500 });
      const container = await until(() => win.contentView.children.find(child => child.children.some(view => view.webContents === page)), Boolean);
      await until(() => container.children[0].getBounds().height, value => value === 500);
      let corners;
      if (process.platform === "darwin") {
        win.showInactive();
        await new Promise(resolve => setTimeout(resolve, 300));
        const sample = (x, y) => execFileSync("swift", [fileURLToPath(new URL("./native/browser-edge.swift", import.meta.url)), String(x), String(y), `${report}-${presentation}.png`, String(process.pid)], { encoding: "utf8" }).trim().split(",").map(Number);
        corners = { backdrop: sample(390, 620), left: sample(401, 629), right: sample(998, 629), center: sample(700, 620) };
      }
      frames.push({ presentation, container: container.getBounds(), page: container.children[0].getBounds(), corners });
    }
    invoke("hide");
    result = { stage, first, second, other, frames, state: state() };
  } else {
    const initial = state();
    invoke("setScope", "session:A");
    const restored = await until(state, s => s.tabs.some(tab => tab.url === `${base}/second` && tab.pageState.status === "ready"));
    const page = webContents.getAllWebContents().find(contents => contents.getURL() === `${base}/second`);
    const storage = await page.executeJavaScript("localStorage.getItem('restoration-proof')");
    const cookies = await session.fromPartition("persist:sofia-browser").cookies.get({ url: base });
    const entries = page.navigationHistory.getAllEntries().map(entry => entry.url);
    const historyIndex = page.navigationHistory.getActiveIndex();
    if (stage === "restore") {
      const background = restored.tabs.find(tab => tab.url === `${base}/background`);
      invoke("closeTab", background.id);
    }
    let remainingOther = null;
    if (stage === "verify-close") {
      invoke("setScope", "session:B");
      await until(state, s => s.tabs.some(tab => tab.url === `${base}/other` && tab.pageState.status === "ready"));
      invoke("setScope", "session:A");
      invoke("closeAllTabs");
      if (state().tabs.length !== 0) throw new Error("Closed scope A retained tabs");
      invoke("setScope", "session:B");
      remainingOther = state();
    }
    result = { stage, activations, initial, restored, storage, remainingOther, cookieRestored: cookies.some(cookie => cookie.name === "restoration-proof"), entries, historyIndex, afterClose: state() };
  }
  panel.flush();
  await session.fromPartition("persist:sofia-browser").cookies.flushStore();
  writeFileSync(report, JSON.stringify(result));
  win.close();
  await until(() => win.isDestroyed(), Boolean);
  app.exit(0);
} catch (error) {
  writeFileSync(report, JSON.stringify({ error: error.stack }));
  app.exit(1);
}

}
void run();
