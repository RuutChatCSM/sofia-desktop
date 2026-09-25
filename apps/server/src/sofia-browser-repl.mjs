#!/usr/bin/env node
// Sofia in-app browser harness for the codex engine. Exposes the browser
// interface the ChatGPT/Codex app uses (mcp__node_repl__js style): the agent runs
// JavaScript that drives `globalThis.agent.browsers`, e.g.
//
//   const agent = await setupBrowserRuntime();
//   const tab = agent.browsers.get("iab").tabs.open();
//   await tab.goto("https://example.com");
//   await tab.snapshot();
//
// Electron <webview> tabs only answer page-domain commands (Page/Runtime/Input)
// on their PAGE-level websocket (/devtools/page/<id>) — a browser-level attach
// session does not route them. So each tab connects to its own page WS (~ the
// app's webContents.debugger equivalent) and drives it directly. The broker
// proxies both /devtools/browser and /devtools/page, so we reach every tab
// through the same Sofia CDP broker URL.
//
// Protocol: newline-delimited JSON-RPC 2.0 on stdio (MCP stdio transport).
import { createInterface } from "node:readline";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import vm from "node:vm";

// The engine records the broker URL in `config.toml` when it prepares a session.
// That port is ephemeral and every build on the machine rewrites the same shared
// config, so the URL we are started with can outlive the app that wrote it. The
// desktop app also publishes the live endpoint to a discovery file beside the
// engine home (see apps/desktop/electron/cdp-broker-discovery.mjs); prefer the
// URL that actually answers so a stale registration self-heals.
const ENV_BROKER_URL = process.env.SOFIA_BROWSER_CDP_URL?.trim() || "";
const DISCOVERY_PATH = path.join(
  process.env.SOFIA_HOME?.trim() || path.join(process.env.HOME?.trim() || ".", ".sofia"),
  "sofia-cdp-broker.json",
);

function discoveryBrokerUrl() {
  try {
    const parsed = JSON.parse(readFileSync(DISCOVERY_PATH, "utf8"));
    return typeof parsed?.url === "string" ? parsed.url.trim() : "";
  } catch {
    return "";
  }
}

function brokerCandidates() {
  return [ENV_BROKER_URL, discoveryBrokerUrl()]
    .filter((url, index, all) => url && all.indexOf(url) === index);
}

async function probeBroker(url) {
  try {
    const res = await fetch(`${url.replace(/\/+$/, "")}/json/version`, { signal: AbortSignal.timeout(2500) });
    return res.ok;
  } catch {
    return false;
  }
}

let resolvedBrokerUrl = "";
async function brokerUrl() {
  if (resolvedBrokerUrl && await probeBroker(resolvedBrokerUrl)) return resolvedBrokerUrl;
  for (const candidate of brokerCandidates()) {
    if (await probeBroker(candidate)) {
      if (candidate !== resolvedBrokerUrl) console.error(`[sofia-repl] browser bridge ${candidate}`);
      resolvedBrokerUrl = candidate;
      return candidate;
    }
  }
  resolvedBrokerUrl = "";
  const tried = brokerCandidates();
  throw new Error(tried.length
    ? `in-app browser bridge is not answering (tried ${tried.join(", ")}). The Sofia window that owns it may have restarted; tell the user instead of driving CDP by hand.`
    : "in-app browser bridge is not configured: SOFIA_BROWSER_CDP_URL is unset and no broker discovery file was found.");
}

function brokerWsUrl(base) {
  return base.replace(/^http/, "ws").replace(/\/+$/, "");
}

const rl = createInterface({ input: process.stdin });
let nextId = 1;
const pending = new Map();
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\n"); }
function reply(id, result) { send({ jsonrpc: "2.0", id, result }); }
function replyError(id, message) { send({ jsonrpc: "2.0", id, error: { code: -32000, message } }); }

// --- Browser-level WS: only for creating targets (createTarget is intercepted) --
let browserWs = null, bId = 1;
const bPending = new Map();
async function browserWsUrl() {
  // The broker proxies /json/version and rewrites its webSocketDebuggerUrl to
  // point at the broker, so we discover the browser WS id dynamically.
  const res = await fetch((await brokerUrl()).replace(/\/+$/, "") + "/json/version", { signal: AbortSignal.timeout(2500) });
  const v = await res.json();
  if (v?.webSocketDebuggerUrl) return v.webSocketDebuggerUrl;
  throw new Error("could not discover browser websocket from /json/version");
}
async function connectBrowser() {
  if (browserWs?.readyState === WebSocket.OPEN) return;
  const url = await browserWsUrl();
  browserWs = new WebSocket(url);
  browserWs.addEventListener("message", async (ev) => {
    const text = await asText(ev.data); let m; try { m = JSON.parse(text); } catch { return; }
    if (m.id != null && bPending.has(m.id)) { const p = bPending.get(m.id); bPending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
  });
  await new Promise((res, rej) => {
    browserWs.addEventListener("open", res);
    browserWs.addEventListener("error", () => rej(new Error("browser ws error")));
    setTimeout(() => rej(new Error("browser ws timeout")), 4000);
  });
}
function cdpBrowser() {
  return new Promise((res, rej) => {
    const id = bId++;
    const t = setTimeout(() => { bPending.delete(id); rej(new Error("cdp timeout")); }, 8000);
    bPending.set(id, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } });
    browserWs.send(JSON.stringify({ id, method: "Target.createTarget", params: { url: "about:blank" } }));
  });
}
async function waitBrowser() {
  if (browserWs?.readyState === WebSocket.OPEN) return;
  await connectBrowser();
}

async function asText(d) {
  if (typeof d === "string") return d;
  if (d instanceof Blob) return new TextDecoder().decode(await d.arrayBuffer());
  if (d instanceof ArrayBuffer) return new TextDecoder().decode(d);
  if (ArrayBuffer.isView(d)) return new TextDecoder().decode(d.buffer, 0, d.byteLength);
  return String(d);
}

// --- Page-level WS per tab: the actual page driver -----------------------------
function connectPage(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 1; const pending = new Map();
  const events = []; // console + network events captured for tab.dev / tab.network
  ws.addEventListener("message", async (ev) => {
    const t = await asText(ev.data); let m; try { m = JSON.parse(t); } catch { return; }
    if (m.id != null && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); return; }
    if (m.method === "Runtime.consoleAPICalled") {
      const args = (m.params?.args ?? []).map((a) => a.value ?? a.description ?? "").join(" ");
      events.push(`console:${m.params?.type ?? "log"}: ${args}`);
      if (events.length > 500) events.shift();
    } else if (m.method === "Runtime.exceptionThrown") {
      events.push(`exception: ${m.params?.exceptionDetails?.exception?.description ?? m.params?.exceptionDetails?.text ?? ""}`);
      if (events.length > 500) events.shift();
    } else if (m.method === "Network.requestWillBeSent") {
      events.push(`request: ${m.params?.request?.url ?? ""}`);
      if (events.length > 500) events.shift();
    } else if (m.method === "Network.responseReceived") {
      const r = m.params?.response ?? {};
      events.push(`response: ${r.status} ${r.url ?? ""}`);
      if (events.length > 500) events.shift();
    } else if (m.method === "Page.javascriptDialogOpening") {
      events.push(`dialog: ${m.params?.type ?? ""}: ${m.params?.message ?? ""}`);
      if (events.length > 500) events.shift();
    }
  });
  const ready = new Promise((res, rej) => {
    ws.addEventListener("open", () => res());
    ws.addEventListener("error", () => rej(new Error("page ws error")));
    setTimeout(() => rej(new Error("page ws timeout")), 4000);
  });
  const send = (method, params = {}, timeout = 12000) => new Promise((res, rej) => {
    const i = id++; const t = setTimeout(() => { pending.delete(i); rej(new Error(`timeout ${method}`)); }, timeout);
    pending.set(i, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  return { ws, send, ready, events };
}

// --- Human-like input ----------------------------------------------------------
// Drive real Input.dispatchMouseEvent (eased, jittered) instead of native
// el.click(). Real events register with React-controlled inputs AND resemble a
// human user, which lowers bot-detection scores.
let lastMouse = null;
async function moveMouseHuman(s, targetX, targetY) {
  const sx = lastMouse?.x ?? (targetX - 60);
  const sy = lastMouse?.y ?? (targetY + 40);
  const steps = 8;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const ease = t * t * (3 - 2 * t); // smoothstep
    const x = Math.round(sx + (targetX - sx) * ease + (i === steps ? 0 : (Math.random() - 0.5) * 3));
    const y = Math.round(sy + (targetY - sy) * ease + (i === steps ? 0 : (Math.random() - 0.5) * 3));
    await s("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" }).catch(() => {});
    await new Promise((r) => setTimeout(r, 12 + Math.random() * 18));
  }
  lastMouse = { x: targetX, y: targetY };
}
async function humanClick(s, x, y) {
  await moveMouseHuman(s, x, y);
  await s("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await new Promise((r) => setTimeout(r, 30 + Math.random() * 40));
  await s("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  return { ok: true, x, y };
}

// --- Shared element resolution ------------------------------------------------
// `RESOLVE` is a JS function (run in the page) that maps a target spec
// ({selector|index|text|role|label|placeholder|testid}) to a DOM element. Every
// action runs it and then operates on the returned node.
const SAFE_LABEL = `function(e){const tag=(e.tagName||'').toLowerCase();const type=String(e.type||'').toLowerCase();const autocomplete=String(e.getAttribute?.('autocomplete')||'').toLowerCase();const protectedField=tag==='input'&&(type==='password'||/(?:current|new)-password|cc-csc/.test(autocomplete));return e.getAttribute?.('aria-label')||e.getAttribute?.('title')||e.innerText||(!protectedField?e.value:'')||e.getAttribute?.('placeholder')||'';}`;
const RESOLVE = `function(t){t=t||{};const safeLabel=${SAFE_LABEL};const coll=()=>Array.from(document.querySelectorAll('a,button,input,select,textarea,label,[role],[aria-label],[data-testid]')).filter(e=>{const vis=e.getClientRects().length>0&&getComputedStyle(e).visibility!=='hidden';const l=safeLabel(e);return vis&&l&&l.trim();});const c=[];let e;if(t.selector){e=document.querySelector(t.selector);if(e)c.push(e);}if(t.index!=null){c.push(coll()[t.index]);}const txt=(t.text||'').trim().toLowerCase();if(txt){const m=coll().find(x=>safeLabel(x).trim().toLowerCase().includes(txt));if(m)c.push(m);}if(t.role){const r=t.role.toLowerCase();const m=coll().find(x=>(x.getAttribute('role')||x.tagName.toLowerCase())===r);if(m)c.push(m);}if(t.placeholder){e=document.querySelector('input[placeholder="'+t.placeholder+'"],textarea[placeholder="'+t.placeholder+'"]');if(e)c.push(e);}if(t.testid){e=document.querySelector('[data-testid="'+t.testid+'"]');if(e)c.push(e);}if(t.label){const m=coll().find(x=>(x.textContent||'').trim()===t.label);if(m)c.push(m);}return c.find(Boolean)||null;}`;
const runAct = (target, action) => `(() => { const e=(${RESOLVE})(${JSON.stringify(target)}); if(!e) return {ok:false,error:'not found'}; try{e.scrollIntoView({block:'center'});}catch{} e.focus(); ${action} })()`;

// Throws when the bridge is unreachable: an empty list would read as "no tabs
// are open" and hide a dead registration from the agent.
async function jsonList() {
  const res = await fetch((await brokerUrl()).replace(/\/+$/, "") + "/json/list", { signal: AbortSignal.timeout(2500) });
  const t = await res.json(); return Array.isArray(t) ? t : [];
}

async function waitForLoad(send, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await send("Runtime.evaluate", { expression: "document.readyState", returnByValue: true });
      if (r?.result?.value === "complete") return;
    } catch { /* page may be mid-navigation */ }
    await new Promise((res) => setTimeout(res, 150));
  }
}
function isSofiaApp(url) { return typeof url === "string" && url.includes("localhost:5173"); }

// --- Stealth: hide CDP/Electron automation fingerprints ------------------------
// Sofia's browser is a real Electron <webview>, but the User-Agent leaks
// "Electron" / "Sofia-Dev", which bot detectors (e.g. timesdaily) flag. We
// override the UA + client hints at the network layer and patch the common
// fingerprint globals on every (sub)document so automation is not detectable.
const STEALTH_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";
const STEALTH_LANG = "en-US";
const STEALTH_UA_METADATA = {
  brands: [
    { brand: "Chromium", version: "150" },
    { brand: "Google Chrome", version: "150" },
    { brand: "Not/A)Brand", version: "24" },
  ],
  fullVersionList: [
    { brand: "Chromium", version: "150.0.0.0" },
    { brand: "Google Chrome", version: "150.0.0.0" },
    { brand: "Not/A)Brand", version: "24.0.0.0" },
  ],
  mobile: false,
  platform: "macOS",
  platformVersion: "15.0.0",
  architecture: "x86_64",
  bitness: "64",
  model: "",
};

const STEALTH_SCRIPT = `(() => {
  try {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined, configurable: true });
    Object.defineProperty(navigator, 'languages', { get: () => [${JSON.stringify(STEALTH_LANG)}], configurable: true });
    Object.defineProperty(navigator, 'language', { get: () => ${JSON.stringify(STEALTH_LANG)}, configurable: true });
    if (navigator.userAgentData) {
      Object.defineProperty(navigator, 'userAgentData', { get: () => ({ brands: [], mobile: false, platform: 'macOS', getHighEntropyValues: () => Promise.resolve({}) }), configurable: true });
    }
    try { Object.defineProperty(navigator, 'plugins', { get: () => [{ name:'PDF Viewer', filename:'internal-pdf-viewer' }], configurable: true }); } catch(e){}
    try { Object.defineProperty(navigator, 'mimeTypes', { get: () => ({ length: 1, item: () => null, namedItem: () => null }), configurable: true }); } catch(e){}
    if (window.chrome && window.chrome.runtime) { try { Object.defineProperty(window.chrome, 'runtime', { get: () => undefined, configurable: true }); } catch(e){} }
    const origQ = navigator.permissions && navigator.permissions.query;
    if (origQ) {
      navigator.permissions.query = (params) => params && params.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission, onchange: null })
        : origQ.call(navigator.permissions, params);
    }
  } catch (e) {}
})();`;

function stealthCheckObj() {
  return `(() => ({ webdriver: (navigator.webdriver===undefined?undefined:navigator.webdriver), ua: navigator.userAgent, languages: navigator.languages, plugins: navigator.plugins.length, chrome: !!window.chrome, appVersion: navigator.appVersion, vendor: navigator.vendor }))()`;
}

// The desktop broker owns cursor rendering for every engine.

// The canonical interactive-element collection used by both `snapshot` and
// `click({index})`, so a snapshot's element `index` always maps to the same node.
const ELEMENTS_EXPR = `Array.from(document.querySelectorAll('a,button,input,select,textarea,label,[role],[aria-label],[data-testid]')).filter((e)=>{const vis=e.getClientRects().length>0&&getComputedStyle(e).visibility!=='hidden';const label=(${SAFE_LABEL})(e);return vis&&label&&label.trim();})`;

// --- Build agent.browsers ------------------------------------------------------
function makeTab(tabEntry) {
  let page = null;
  const pageTargetId = tabEntry.targetId;
  let stealthApplied = false;
  const ensure = async () => {
    if (!page) {
      // Re-resolve the tab's page WS (it may have moved after the marker nav).
      const list = await jsonList();
      const wsBase = brokerWsUrl(await brokerUrl());
      const entry = list.find((t) => t.id === pageTargetId) || { webSocketDebuggerUrl: `${wsBase}/devtools/page/${pageTargetId}` };
      const p = connectPage(entry.webSocketDebuggerUrl ? entry.webSocketDebuggerUrl.replace(/^ws/, wsBase.startsWith("wss") ? "wss" : "ws") : `${wsBase}/devtools/page/${pageTargetId}`);
      await p.ready;
      page = p;
      if (!stealthApplied) {
        stealthApplied = true;
        try {
          await page.send("Network.enable", {});
          await page.send("Page.enable", {});
          await page.send("Network.setUserAgentOverride", {
            userAgent: STEALTH_UA,
            acceptLanguage: STEALTH_LANG,
            userAgentMetadata: STEALTH_UA_METADATA,
          });
          await page.send("Page.addScriptToEvaluateOnNewDocument", { source: STEALTH_SCRIPT }).catch(() => {});
          await page.send("Runtime.evaluate", { expression: STEALTH_SCRIPT }).catch(() => {});
        } catch {
          // Stealth is best-effort; never fail the session over it.
        }
      }
    }
    return page.send;
  };
  const tab = {
    id: tabEntry.id,
    url: async () => (await jsonList()).find((t) => t.id === pageTargetId)?.url ?? tabEntry.url,
    title: async () => (await jsonList()).find((t) => t.id === pageTargetId)?.title ?? tabEntry.title,
    goto: async (url) => { const s = await ensure(); await s("Page.navigate", { url }); await waitForLoad(s); return true; },
    back: async () => { const s = await ensure(); try { const h = await s("Page.getNavigationHistory", {}); const cur = h?.currentIndex ?? 0; if (cur > 0) { await s("Page.navigateToHistoryEntry", { entryId: h.entries[cur - 1].id }); return true; } return true; } catch { await s("Page.goBack", {}).catch(() => {}); return true; } },
    forward: async () => { const s = await ensure(); try { const h = await s("Page.getNavigationHistory", {}); const cur = h?.currentIndex ?? 0; if (cur < (h?.entries?.length ?? 0) - 1) { await s("Page.navigateToHistoryEntry", { entryId: h.entries[cur + 1].id }); return true; } return true; } catch { await s("Page.goForward", {}).catch(() => {}); return true; } },
    reload: async () => { const s = await ensure(); await s("Page.reload", {}); return true; },
    close: async () => { await (await ensure())("Target.closeTarget", { targetId: pageTargetId }); page?.ws.close(); return true; },
    screenshot: async () => { const s = await ensure(); const r = await s("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }, 15000); return { data: r?.data ?? "", mimeType: "image/png" }; },
    saveScreenshot: async (path) => { const img = await tab.screenshot(); const fs = nodeRequire("node:fs"); fs.writeFileSync(path, Buffer.from(img.data, "base64")); return { saved: true, path, bytes: Buffer.byteLength(img.data, "base64") }; },
    elementScreenshot: async (target) => { try { const s = await ensure(); const r = await s("Runtime.evaluate", { expression: runAct(target, `const b=e.getBoundingClientRect();return {ok:true,clip:{x:Math.max(0,b.x),y:Math.max(0,b.y),width:b.width,height:b.height}};`), returnByValue: true }); const clip = r?.result?.value?.clip; if (!clip) return { ok: false, error: "not found" }; const shot = await s("Page.captureScreenshot", { format: "png", clip, captureBeyondViewport: true }, 15000); return { data: shot?.data ?? "", mimeType: "image/png" }; } catch { const img = await tab.screenshot(); return img; } },
    snapshot: async () => { const s = await ensure(); const expr = `(() => { const els=${ELEMENTS_EXPR}; const safeLabel=${SAFE_LABEL}; const elements=els.map((el,index)=>{const tag=el.tagName.toLowerCase();const role=el.getAttribute('role')||tag;const label=safeLabel(el);return {index,role,tag,label:label.trim().slice(0,120)};}); return JSON.stringify({title:document.title,url:location.href,elements}); })()`; const r = await s("Runtime.evaluate", { expression: expr, returnByValue: true }); return { text: r?.result?.value ?? "" }; },
    // The agent's single "look": title, url, and the interactive elements
    // (index/role/label) in one call, so it never chains snapshot+ax.
    see: async () => { const t = await tab.snapshot(); let s = null; try { s = JSON.parse(t.text); } catch { s = { title: "", url: "", elements: [] }; } return { title: s.title ?? "", url: s.url ?? "", elements: s.elements ?? [], ax: null }; },
    domSnapshot: async () => { const s = await ensure(); const r = await s("Runtime.evaluate", { expression: `JSON.stringify({title:document.title,url:location.href,html:document.documentElement.outerHTML.slice(0,20000)})`, returnByValue: true }); return { text: r?.result?.value ?? "" }; },
    evaluate: async (script) => { const s = await ensure(); const r = await s("Runtime.evaluate", { expression: script, returnByValue: true, awaitPromise: true }); return r?.result?.value ?? r?.result?.description ?? null; },
    waitForLoadState: async () => { const s = await ensure(); return await waitForLoad(s); },
    waitForTimeout: async (ms = 1000) => { await new Promise((r) => setTimeout(r, ms)); return true; },
    waitFor: async (target, { state = "visible", timeout = 8000 } = {}) => { const s = await ensure(); const deadline = Date.now() + timeout; while (Date.now() < deadline) { const r = await s("Runtime.evaluate", { expression: `(() => { const e=(${RESOLVE})(${JSON.stringify(target)}); if(!e) return false; const vis=e.getClientRects().length>0&&getComputedStyle(e).visibility!=='hidden'; const present=document.documentElement.contains(e); return ${JSON.stringify(state)==='visible' ? 'vis' : JSON.stringify(state)==='attached' ? 'present' : 'vis'}; })()`, returnByValue: true }); if (r?.result?.value) return true; await new Promise((r) => setTimeout(r, 200)); } return false; },
    getByText: async (text, { exact } = {}) => { const s = await ensure(); const r = await s("Runtime.evaluate", { expression: `(() => { const els=${ELEMENTS_EXPR}; const safeLabel=${SAFE_LABEL}; const needle=${JSON.stringify(String(text).toLowerCase())}; const i=els.findIndex(e=>{const val=safeLabel(e).trim();return ${exact ? 'val.toLowerCase()===needle' : 'val.toLowerCase().includes(needle)'};}); if(i<0) return {ok:false}; const e=els[i]; return {ok:true,index:i,tag:e.tagName.toLowerCase(),label:(e.textContent||'').trim().slice(0,80)}; })()`, returnByValue: true }); return r?.result?.value ?? { ok: false }; },
    getByRole: async (role) => { const s = await ensure(); const r = await s("Runtime.evaluate", { expression: `(() => { const els=${ELEMENTS_EXPR}; const mapf=(e)=>{const r=e.getAttribute('role');if(r)return r;const tag=e.tagName.toLowerCase();if(tag==='a')return 'link';if(tag==='button'||e.type==='button'||e.type==='submit')return 'button';if(tag==='input')return e.type==='checkbox'?'checkbox':e.type==='radio'?'radio':e.type==='file'?'button':'textbox';if(tag==='select')return 'combobox';if(tag==='textarea')return 'textbox';if(tag==='img')return 'img';if(/^h[1-6]$/.test(tag))return 'heading';return tag;}; const needle=${JSON.stringify(String(role).toLowerCase())}; const i=els.findIndex(e=>mapf(e)===needle); if(i<0) return {ok:false}; const e=els[i]; return {ok:true,index:i,tag:e.tagName.toLowerCase(),role:mapf(e),label:(e.textContent||'').trim().slice(0,80)}; })()`, returnByValue: true }); return r?.result?.value ?? { ok: false }; },
    getByLabel: async (label) => { const s = await ensure(); const r = await s("Runtime.evaluate", { expression: `(() => { const els=${ELEMENTS_EXPR}; const needle=${JSON.stringify(String(label))}; const i=els.findIndex(e=>(e.getAttribute('aria-label')||'').trim()===needle||(e.textContent||'').trim()===needle); if(i<0) return {ok:false}; const e=els[i]; return {ok:true,index:i,tag:e.tagName.toLowerCase(),label:(e.textContent||e.getAttribute('aria-label')||'').trim().slice(0,80)}; })()`, returnByValue: true }); return r?.result?.value ?? { ok: false }; },
    getByPlaceholder: async (placeholder) => { const s = await ensure(); const r = await s("Runtime.evaluate", { expression: `(() => { const els=${ELEMENTS_EXPR}; const needle=${JSON.stringify(String(placeholder))}; const i=els.findIndex(e=>(e.getAttribute('placeholder')||'')===needle); if(i<0) return {ok:false}; const e=els[i]; return {ok:true,index:i,tag:e.tagName.toLowerCase(),label:e.getAttribute('placeholder')||''}; })()`, returnByValue: true }); return r?.result?.value ?? { ok: false }; },
    getByTestId: async (testid) => { const s = await ensure(); const r = await s("Runtime.evaluate", { expression: `(() => { const els=${ELEMENTS_EXPR}; const needle=${JSON.stringify(String(testid))}; const i=els.findIndex(e=>(e.getAttribute('data-testid')||'')===needle); if(i<0) return {ok:false}; const e=els[i]; return {ok:true,index:i,tag:e.tagName.toLowerCase(),label:(e.textContent||'').trim().slice(0,80)}; })()`, returnByValue: true }); return r?.result?.value ?? { ok: false }; },
    querySelector: async (selector) => { const s = await ensure(); const r = await s("Runtime.evaluate", { expression: `(() => { const e=document.querySelector(${JSON.stringify(selector)}); if(!e) return {ok:false}; return {ok:true,tag:e.tagName.toLowerCase(),text:(e.textContent||'').trim().slice(0,120)}; })()`, returnByValue: true }); return r?.result?.value ?? { ok: false }; },
    locator: async (selector) => { const s = await ensure(); const r = await s("Runtime.evaluate", { expression: `(() => { const els=Array.from(document.querySelectorAll(${JSON.stringify(selector)})).filter(e=>e.getClientRects().length>0); return els.map((e,i)=>({index:i,tag:e.tagName.toLowerCase(),text:(e.textContent||'').trim().slice(0,80)})); })()`, returnByValue: true }); return r?.result?.value ?? []; },
    click: async (target = {}) => { const s = await ensure(); const hasTarget = target && (target.selector != null || target.index != null || target.text != null || target.role != null || target.label != null || target.placeholder != null || target.testid != null); if (hasTarget) { const r = await s("Runtime.evaluate", { expression: runAct(target, `const b=e.getBoundingClientRect(); return {ok:true, x:Math.round(b.x+b.width/2), y:Math.round(b.y+b.height/2)};`), returnByValue: true }); const c = r?.result?.value; if (c?.ok) return await humanClick(s, c.x, c.y); return { ok: false, error: "target not found" }; } const x = Number(target?.x) || 0, y = Number(target?.y) || 0; if (!(target?.x != null && target?.y != null)) return { ok: false, error: "no target and no coordinates" }; return await humanClick(s, x, y); },
    dblclick: async (target) => { const s = await ensure(); const r = await s("Runtime.evaluate", { expression: runAct(target, `const o={bubbles:true,cancelable:true,view:window}; e.dispatchEvent(new MouseEvent('dblclick',o)); e.click(); e.click(); return {ok:true};`), returnByValue: true }); return r?.result?.value ?? { ok: false }; },
    hover: async (target) => { const s = await ensure(); const r = await s("Runtime.evaluate", { expression: runAct(target, `const o={bubbles:true,cancelable:true,view:window}; e.dispatchEvent(new MouseEvent('mouseover',o)); e.dispatchEvent(new MouseEvent('mouseenter',o)); e.dispatchEvent(new MouseEvent('mousemove',o)); return {ok:true};`), returnByValue: true }); return r?.result?.value ?? { ok: false }; },
    fill: async (target, value) => { const s = await ensure(); const r = await s("Runtime.evaluate", { expression: runAct(target, `const v=${JSON.stringify(value)}; const setter=Object.getOwnPropertyDescriptor(e.__proto__||e,'value')?.set||((x)=>{e.value=x;}); try{setter.call(e,v);}catch(_){e.value=v;} e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return {ok:true};`), returnByValue: true }); return r?.result?.value ?? { ok: false, error: "fill failed" }; },
    select: async (target, value) => { const s = await ensure(); const r = await s("Runtime.evaluate", { expression: runAct(target, `if(e.tagName!=='SELECT') return {ok:false,error:'not a select'}; e.value=${JSON.stringify(value)}; e.dispatchEvent(new Event('change',{bubbles:true})); return {ok:true,value:e.value};`), returnByValue: true }); return r?.result?.value ?? { ok: false }; },
    check: async (target) => { const s = await ensure(); const r = await s("Runtime.evaluate", { expression: runAct(target, `if(e.type==='checkbox'||e.getAttribute('role')==='checkbox'){e.checked=!e.checked; e.dispatchEvent(new Event('change',{bubbles:true}));} e.click(); return {ok:true,checked:!!e.checked};`), returnByValue: true }); return r?.result?.value ?? { ok: false }; },
    press: async (target, key) => { const s = await ensure(); const r = await s("Runtime.evaluate", { expression: runAct(target, `const o={bubbles:true,cancelable:true,key:${JSON.stringify(key)},code:${JSON.stringify(key)},which:${JSON.stringify(key.length===1?key.charCodeAt(0):0)}}; e.dispatchEvent(new KeyboardEvent('keydown',o)); e.dispatchEvent(new KeyboardEvent('keypress',o)); e.dispatchEvent(new KeyboardEvent('keyup',o)); return {ok:true};`), returnByValue: true }); return r?.result?.value ?? { ok: false }; },
    type: async ({ text } = {}) => { const s = await ensure(); const r = await s("Runtime.evaluate", { expression: `(() => { const el=document.activeElement; if(!el) return {ok:false}; const cur=(el.value||''); const v=cur+${JSON.stringify(text || '')}; const setter=Object.getOwnPropertyDescriptor(el.__proto__||el,'value')?.set||((x)=>{el.value=x;}); try{setter.call(el,v);}catch(_){el.value=v;} el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return {ok:true}; })()`, returnByValue: true }); if (!r?.result?.value?.ok) await s("Input.insertText", { text }); return { ok: true }; },
    keypress: async ({ combo }) => { const s = await ensure(); const c = String(combo || "").split("+"); const [mod, key] = c.length > 1 ? [c[0], c.slice(1).join("+")] : [null, c[0]]; const mods = { command: "Meta", cmd: "Meta", meta: "Meta", ctrl: "Control", control: "Control", alt: "Alt", option: "Alt", shift: "Shift" }; const modifiers = mod ? (mods[mod.toLowerCase()] ?? mod) : null; const rawKey = { control: "Control", ctrl: "Control", command: "Meta", meta: "Meta", alt: "Alt", option: "Alt", shift: "Shift", return: "Enter", enter: "Enter", escape: "Escape", tab: "Tab", space: " ", " ": " " }[key.toLowerCase()] ?? key; await s("Input.dispatchKeyEvent", { type: "rawKeyDown", key: rawKey, code: rawKey, windowsVirtualKeyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0, modifiers: modifiers ? { "Meta": 4, "Control": 2, "Alt": 1, "Shift": 8 }[modifiers] ?? 0 : 0 }); await s("Input.dispatchKeyEvent", { type: "keyUp", key: rawKey, code: rawKey }); return true; },
    ax: {
      get: async () => { const s = await ensure(); try { await s("Accessibility.enable", {}).catch(() => {}); const { nodes } = await s("Accessibility.getFullAXTree", {}, 15000); const interactive = ["button","link","textbox","checkbox","radio","combobox","menuitem","menuitemcheckbox","tab","heading","img","listitem","option","switch","slider","spinbutton"]; return (nodes ?? []).filter((n) => n.role?.value && interactive.includes(n.role.value)).map((n) => ({ ref: n.backendDOMNodeId ?? n.nodeId, role: n.role.value, name: n.name?.value ?? "" })).slice(0, 200); } catch { return []; } },
      click: async ({ ref }) => { const t = await tab.ax.get(); const found = t.find((x) => String(x.ref) === String(ref)); if (!found?.name) return { ok: false, error: "ax ref not found" }; return await tab.click({ text: found.name }); },
      pressKey: async ({ ref, combo }) => { const t = await tab.ax.get(); const found = t.find((x) => String(x.ref) === String(ref)); if (found?.name) await tab.click({ text: found.name }); return await tab.keypress({ combo }); },
      setValue: async ({ ref, value }) => { const t = await tab.ax.get(); const found = t.find((x) => String(x.ref) === String(ref)); if (!found?.name) return { ok: false }; return await tab.fill({ label: found.name, text: found.name }, value); },
      typeText: async ({ ref, text }) => { return await tab.keypress({ combo: "" }) && await tab.type({ text }); },
      scroll: async ({ ref, direction }) => { const t = await tab.ax.get(); const found = t.find((x) => String(x.ref) === String(ref)); if (found?.name) await tab.click({ text: found.name }); const s = await ensure(); await s("Input.dispatchMouseEvent", { type: "mouseWheel", x: 0, y: 0, deltaX: direction === "left" || direction === "right" ? (direction === "right" ? 120 : -120) : 0, deltaY: direction === "down" ? 120 : direction === "up" ? -120 : 0 }); return true; },
    },
    clipboard: {
      readText: async () => { const s = await ensure(); const r = await s("Runtime.evaluate", { expression: `(() => { const ta=document.createElement('textarea'); ta.style.position='fixed'; ta.style.opacity='0'; document.body.appendChild(ta); ta.focus(); document.execCommand('paste'); const v=ta.value; ta.remove(); return v; })()`, returnByValue: true }); return r?.result?.value ?? ""; },
      writeText: async (text) => { const s = await ensure(); await s("Runtime.evaluate", { expression: `(() => { const ta=document.createElement('textarea'); ta.value=${JSON.stringify(text)}; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); return true; })()`, returnByValue: true }); return { ok: true }; },
    },
    content: { export: async () => { const s = await ensure(); const r = await s("Runtime.evaluate", { expression: `(() => JSON.stringify({title:document.title,url:location.href,text:document.body.innerText.slice(0,20000)}))()`, returnByValue: true }); return r?.result?.value ?? ""; } },
    dev: { logs: async () => (await ensure(), page?.events ?? []).filter((e) => e.startsWith("console:") || e.startsWith("exception:")) },
    network: {
      requests: async () => (await ensure(), page?.events ?? []).filter((e) => e.startsWith("request:")),
      responses: async () => (await ensure(), page?.events ?? []).filter((e) => e.startsWith("response:")),
    },
    dialog: {
      get: async () => { const s = await ensure(); const found = (page?.events ?? []).find((e) => e.startsWith("dialog:")); return found ? { message: found.slice(7) } : null; },
      accept: async (text) => { const s = await ensure(); await s("Page.handleJavaScriptDialog", { accept: true, promptText: text }).catch(() => {}); return true; },
      dismiss: async () => { const s = await ensure(); await s("Page.handleJavaScriptDialog", { accept: false }).catch(() => {}); return true; },
    },
    frames: {
      list: async () => { const s = await ensure(); const r = await s("Runtime.evaluate", { expression: `JSON.stringify(Array.from(document.querySelectorAll('iframe')).map((f,i)=>({index:i,src:f.src,name:f.name})))`, returnByValue: true }); try { return JSON.parse(r?.result?.value ?? "[]"); } catch { return []; } },
    },
    visibility: { get: async () => true, set: async () => true },
    cdp: { send: async (method, params) => { const s = await ensure(); return await s(method, params ?? {}); } },
    stealth: async () => { const s = await ensure(); const r = await s("Runtime.evaluate", { expression: stealthCheckObj(), returnByValue: true }); return r?.result?.value ?? null; },
    botDetection: {
      get: async () => { const s = await ensure(); const r = await s("Runtime.evaluate", { expression: stealthCheckObj(), returnByValue: true }); return { detected: (r?.result?.value?.webdriver ?? false) === true || /Electron|Sofia-Dev/.test(String(r?.result?.value?.ua ?? "")), fingerprint: r?.result?.value ?? null }; },
      check: async () => { const s = await ensure(); const r = await s("Runtime.evaluate", { expression: `(() => { const txt=(document.body.innerText||'').toLowerCase(); const has = /captcha|verify you are human|are you a robot|unusual traffic|security check|turnstile|challenge/i.test(txt) || !!document.querySelector('iframe[src*="captcha"],iframe[src*="turnstile"],iframe[src*="recaptcha"],iframe[src*="challenge"],iframe[src*="hcaptcha"]'); return { captcha: has, text: has ? (document.body.innerText||'').match(/captcha|verify you are human|unusual traffic|security check/i)?.[0]||'captcha' : null }; })()`, returnByValue: true }); return r?.result?.value ?? { captcha: false, text: null }; },
      report: async () => { return { ok: true, reported: true, advice: "A CAPTCHA/human-verification wall was hit. Stop and hand off to the user — do not retry in this session. Recommend the user completes it in a normal browser." }; },
    },
    documentation: async () => tabDoc(),
  };
  return tab;
}

function makeBrowser(browserId) {  const browser = {
    id: browserId,
    tabs: {
      list: async () => { const list = await jsonList(); return list.filter((t) => t.type === "page" && !isSofiaApp(t.url)).map((t) => makeTab({ id: t.id, targetId: t.id, url: t.url, title: t.title })); },
      openTabs: async () => await browser.tabs.list(),
      open: async (url = "about:blank") => {
        await waitBrowser();
        const { targetId } = await cdpBrowser();
        const list = await jsonList();
        const entry = list.find((t) => t.id === targetId);
        const tab = makeTab({ id: targetId, targetId, url: entry?.url ?? url, title: entry?.title ?? "" });
        if (url && url !== "about:blank") await tab.goto(url);
        return tab;
      },
    },
    user: { openTabs: async () => await browser.tabs.list() },
    documentation: async () => browserDoc(),
  };
  return browser;
}

// Singleton runtime: the agent's `setupBrowserRuntime()` returns this.
// `browsers.get(id)` is SYNCHRONOUS (returns the browser object) so the agent's
// `agent.browsers.get("iab").tabs.open(url)` chaining works exactly like the
// app's interface. Individual tab/browser operations are async.
const inAppBrowser = makeBrowser("iab");
globalThis.agent = {
  browsers: {
    get: (id) => {
      if (id !== "iab") throw new Error(`browser not available: ${id}`);
      return inAppBrowser;
    },
    getDefault: async () => inAppBrowser,
    getForUrl: async () => inAppBrowser,
    list: async () => ["iab"],
  },
};
// Resolving the endpoint here is what surfaces a dead bridge to the agent:
// silently returning the runtime left every later call failing far from the
// cause. Only the HTTP probe is required — the browser-level socket that
// `tabs.open()` needs is established on demand.
globalThis.setupBrowserRuntime = async function setupBrowserRuntime() { await brokerUrl(); return globalThis.agent; };

function browserDoc() {
  return `# In-App Browser

const agent = await setupBrowserRuntime();
const browser = agent.browsers.get("iab");
await agent.browsers.getDefault();             // runtime-selected browser
await agent.browsers.getForUrl("https://…");  // browser suitable for a URL
await browser.user.openTabs();                 // tabs in this user session
const tab = await browser.tabs.open("https://…");   // open a visible tab
const view = await tab.see();                        // {url, title, elements[{index,role,label}]}
await tab.click({index:0});                          // act by index/text/role
await tab.see();                                     // verify changed state
await tab.fill({role:"textbox"}, "value");
await tab.goto(url); await tab.snapshot();
await tab.close();

Reliable browser protocol:
- Read this documentation once per fresh session.
- Inspect with tab.see() (or tab.ax.get()) before choosing an action.
- Use index/text/role from the latest snapshot.
- After navigation or any action that changes page state, inspect again before choosing the next action.
- Batch actions only when they are independent and the required state is already known.
- Screenshot ONLY when the a11y tree is ambiguous; otherwise read the tree.
- Re-use the open tab; don't open new tabs repeatedly.
- If a call reports "in-app browser bridge is not answering", the app window that owns the bridge has probably restarted. Report that to the user; never reconnect to Chromium over raw CDP by hand.
- CAPTCHA? Call tab.botDetection.check() once. If .captcha is true, STOP, report, hand off — never loop.`;
}
function tabDoc() {
  return `# Tab
see() -> {url,title,elements[{index,role,label}]}      // the agent's single "look"
url() title() goto(url) back() forward() reload() close()
screenshot() saveScreenshot(path) snapshot() evaluate(js)
click({index|text|role|label|selector}) dblclick hover fill({target},value) select check press
type({text}) keypress({combo}) waitFor({text},{state}) waitForTimeout(ms)
ax.get() ax.click({ref}) ax.setValue({ref},v) ax.pressKey ax.typeText ax.scroll
clipboard.readText() clipboard.writeText(v) content.export() dev.logs()
dialog.get() dialog.accept(text) dialog.dismiss() frames.list()
cdp.send(method, params) stealth() botDetection.get() botDetection.report()`;
}

// --- MCP stdio protocol --------------------------------------------------------
function handleLine(line) {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined || typeof msg.method !== "string") return;
  handleRequest(msg.id, msg.method, msg.params ?? {}).catch((e) => replyError(msg.id, e.message));
}
rl.on("line", handleLine);

async function handleRequest(id, method, params) {
  switch (method) {
    case "initialize":
      return reply(id, { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "sofia-browser-repl", version: "1.0.0" } });
    case "notifications/initialized":
      return;
    case "ping":
      return reply(id, {});
    case "tools/list":
      return reply(id, { tools: [jsTool()] });
    case "tools/call": {
      if (params.name !== "js") return replyError(id, "unknown tool");
      const code = String(params.arguments?.code ?? params.arguments?.source ?? "");
      const result = await runJs(code);
      return reply(id, { content: result });
    }
    default:
      return replyError(id, `method not found: ${method}`);
  }
}

function jsTool() {
  return {
    name: "js",
    description: `Drive the visible, signed-in Sofia browser by running JavaScript. Initialize with setupBrowserRuntime(), read browser.documentation() before first use, inspect the latest page state with tab.see() or tab.ax.get(), then act by index/text/role. Re-inspect after navigation or state-changing actions before deciding what to do next. Pattern:
const browser = (await setupBrowserRuntime()).browsers.get("iab"); await browser.documentation(); const tab = await browser.tabs.open("url"); const view = await tab.see(); await tab.click({index:view.elements[0].index}); await tab.see();
Use tab.getByText/getByRole/fill/select/check/waitFor; use screenshots when the semantic tree is ambiguous.
If a call reports "in-app browser bridge is not answering", the app window that owns the bridge has restarted: say so and stop, never reconnect over raw CDP by hand.
CAPTCHA: if tab.botDetection.check().captcha is true, STOP — call tab.botDetection.report() and hand control to the user. Never loop or retry a captcha.`,
    inputSchema: { type: "object", properties: { code: { type: "string", description: "JavaScript to run (async allowed)" } }, required: ["code"] },
  };
}

const nodeRequire = createRequire(import.meta.url);

function mcpContent(result) {
  if (result && typeof result === "object" && typeof result.data === "string" && /^image\//.test(result.mimeType ?? "")) {
    return [{ type: "image", data: result.data, mimeType: result.mimeType }];
  }
  return [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }];
}

// Browser and tab bindings assigned to globalThis survive later tool calls,
// matching the persistent Node-REPL contract. Model-authored JavaScript does
// not receive Node's process object or module loader.
const callOutput = new AsyncLocalStorage();
const captureOutput = (...values) => {
  const output = callOutput.getStore();
  for (const value of values) output?.push(...mcpContent(value ?? "null"));
};
const runtimeSandbox = {
  agent: globalThis.agent,
  setupBrowserRuntime: globalThis.setupBrowserRuntime,
  display: captureOutput,
  console: { log: captureOutput, info: captureOutput, warn: captureOutput, error: captureOutput, debug: captureOutput },
  fetch,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  Buffer,
  TextEncoder,
  TextDecoder,
  URL,
};
const runtimeContext = vm.createContext(runtimeSandbox, {
  codeGeneration: { strings: false, wasm: false },
});

async function runJs(code) {
  return callOutput.run([], async () => {
    const value = await vm.runInContext(`(async()=>{ ${code} })()`, runtimeContext, { timeout: 1000 });
    const output = callOutput.getStore();
    if (value !== undefined) output.push(...mcpContent(value));
    return output.length ? output : mcpContent("done");
  });
}

waitBrowser().catch(() => {});
