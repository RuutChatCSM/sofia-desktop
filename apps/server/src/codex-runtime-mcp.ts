// Codex runtime surfaces: MCP servers + skills that Sofia provisions into the
// bundled codex (Sofia) engine's config.toml and codex home. Mirrors the
// ChatGPT/Codex app's "capabilities = SKILL.md + plugin that registers tools +
// MCP bridge" model (see reference/codex-app TOOLS-SKILLS.md): each surface is a
// SKILL.md the agent must obey plus an MCP server the skill points at.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mcpApprovalModeFor, readCodexAccessMode } from "./codex-access.js";

export type CodexRuntimeMcpServer = {
  name: string;
  command?: string;
  url?: string;
  httpHeaders?: Record<string, string>;
  disabledTools?: string[];
  startupTimeoutSec?: number;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  enabled?: boolean;
  /** codex AppToolApproval: "auto" | "prompt" | "writes" | "approve". */
  defaultApprovalMode?: "auto" | "prompt" | "writes" | "approve";
  /** Tool names to surface (allow-list) when set. */
  enabledTools?: string[];
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const serverRoot = resolve(__dirname, "..", "..");
const handsfreeBin = resolve(serverRoot, "packages", "handsfree", "bin", "sofia-handsfree-computer-use.mjs");

/** Resolve the handsfree computer-use adapter as a direct `node` invocation. */
export function resolveComputerUseInvocation(): { command: string; args: string[]; env: Record<string, string> } | null {
  const bin = resolveComputerUseCommand();
  if (!bin) return null;
  return /\.[cm]?js$/.test(bin)
    ? { command: process.execPath, args: [bin, "mcp"], env: { ELECTRON_RUN_AS_NODE: "1" } }
    : { command: bin, args: ["mcp"], env: {} };
}

/** Resolve the in-app browser Node REPL harness (mcp__node_repl__js) as a direct
 * `node` invocation. It exposes `agent.browsers.get("iab")` to the codex agent,
 * backed by the same local CDP broker (Electron <webview> page sessions). */
export function resolveBrowserReplInvocation(): { command: string; args: string[]; env: Record<string, string> } | null {
  const here = dirname(__filename);
  // Dev build: the harness sits beside this module in src/. Dist builds may keep
  // it under a copied location; try the source dir as the fallback.
  const candidates = [
    resolve(here, "sofia-browser-repl.mjs"),
    resolve(here, "..", "src", "sofia-browser-repl.mjs"),
  ];
  const harness = candidates.find((candidate) => existsSync(candidate));
  if (!harness) return null;
  const discoveryPath = join(process.env.SOFIA_HOME?.trim() || join(homedir(), ".sofia"), "sofia-cdp-broker.json");
  let discoveredUrl = "";
  try {
    const record: unknown = JSON.parse(readFileSync(discoveryPath, "utf8"));
    if (record && typeof record === "object" && "url" in record && typeof record.url === "string") {
      discoveredUrl = record.url.trim();
    }
  } catch {
    // The live environment variable is sufficient when no discovery file exists.
  }
  const brokerUrl = process.env.SOFIA_ELECTRON_AGENT_CDP_BASE_URL?.trim() || discoveredUrl;
  return {
    command: process.execPath,
    args: [harness],
    env: { ELECTRON_RUN_AS_NODE: "1", ...(brokerUrl ? { SOFIA_BROWSER_CDP_URL: brokerUrl } : {}) },
  };
}

function envFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function isMacOS(): boolean {
  return process.platform === "darwin";
}

/** Resolve the handsfree computer-use adapter binary for an MCP `command`. */
export function resolveComputerUseCommand(): string | null {
  const pinned = process.env.SOFIA_COMPUTER_USE_BINARY?.trim() || process.env.HANDSFREE_COMPUTER_USE_BINARY?.trim();
  if (pinned) return pinned;
  if (existsSync(handsfreeBin)) return handsfreeBin;
  return "sofia-handsfree-computer-use";
}

/** True when computer use should be wired into the codex engine. Opt-in only:
 * computer-use surfaces macOS Accessibility/Screen Recording permission prompts,
 * so it must never auto-enable from the binary's mere presence. The user enables
 * it (SOFIA_CODEX_COMPUTER_USE=1) or a packaged helper grants the grant; a
 * bare build stays silent until then. */
export function computerUseEnabled(): boolean {
  if (!isMacOS()) return false;
  return envFlag("SOFIA_CODEX_COMPUTER_USE", false);
}

/**
 * The MCP servers Sofia registers with the codex engine. Additive and
 * best-effort: only servers whose backing runtime is present are returned, so a
 * bare server build never references a missing sidecar.
 */
export function defaultCodexRuntimeMcpServers(): CodexRuntimeMcpServer[] {
  const servers: CodexRuntimeMcpServer[] = [];
  // The access mode (the composer toggle) maps to the MCP approval (prompting)
  // half of one aligned control: ask -> prompt, approve -> auto, full -> approve.
  const approval = mcpApprovalModeFor(readCodexAccessMode());

  if (computerUseEnabled()) {
    const invocation = resolveComputerUseInvocation();
    if (invocation) {
      servers.push({
        name: "computer-use",
        command: invocation.command,
        args: invocation.args,
        env: invocation.env,
        // Screen input is destructive: never let the agent act without asking.
        defaultApprovalMode: approval,
        enabled: true,
      });
    }
  }

  // The in-app browser surface. chrome-devtools-mcp hung against Electron
  // <webview> targets (its Puppeteer new_page lifecycle never settles), so the
  // codex agent gets the app-parity surface instead: a Node REPL `js` tool
  // (mcp__node_repl__js) that exposes `agent.browsers.get("iab")` backed by the
  // same local CDP broker, driven over each tab's page-level websocket.
  const replInvocation = resolveBrowserReplInvocation();
  if (replInvocation) {
    servers.push({
      name: "node_repl",
      startupTimeoutSec: 20,
      enabledTools: ["js"],
      command: replInvocation.command,
      args: replInvocation.args,
      env: replInvocation.env,
      // The js tool runs arbitrary agent code, so approval must auto-run in
      // access modes that allow it ("approve"->auto, "full"->approve). In "ask"
      // it prompts. NOTE: prompting on this tool triggers a separate codex
      // model-turn harness the app must answer (see the approval surface).
      defaultApprovalMode: approval,
      enabled: true,
    });
  }

  return servers;
}

/** Translate the app's saved local/remote MCP entries, including plugin components.
 * Explicit workspace entries override automatic defaults, including disablement.
 * An entry the engine cannot represent is skipped with a warning: one bad row
 * must never cost the workspace its whole engine configuration. */
export function configuredCodexMcpServers(
  mcp: Record<string, Record<string, unknown>>,
  defaults: CodexRuntimeMcpServer[] = defaultCodexRuntimeMcpServers(),
): CodexRuntimeMcpServer[] {
  const servers = new Map(defaults.map((server) => [server.name, server]));
  for (const [name, config] of Object.entries(mcp)) {
    const common = {
      name,
      enabled: config.enabled !== false,
      defaultApprovalMode: mcpApprovalModeFor(readCodexAccessMode()),
      ...(Array.isArray(config.enabled_tools) ? { enabledTools: strings(config.enabled_tools) } : {}),
      ...(Array.isArray(config.disabled_tools) ? { disabledTools: strings(config.disabled_tools) } : {}),
      ...(typeof config.timeout === "number" && Number.isFinite(config.timeout) && config.timeout > 0
        ? { startupTimeoutSec: config.timeout / 1000 } : {}),
    };
    if (config.type === "local" && Array.isArray(config.command)) {
      const [command, ...args] = strings(config.command);
      if (!command) {
        warnUntranslatableMcp(name, "local MCP entry has no executable");
        continue;
      }
      servers.set(name, { ...common, command, args, env: stringMap(config.environment),
        ...(typeof config.cwd === "string" ? { cwd: config.cwd } : {}),
      });
    } else if (config.type === "remote" && typeof config.url === "string") {
      servers.set(name, { ...common, url: config.url, httpHeaders: stringMap(config.headers) });
    } else {
      warnUntranslatableMcp(name, `unsupported transport ${JSON.stringify(config.type ?? null)}`);
    }
  }
  return [...servers.values()];
}

function warnUntranslatableMcp(name: string, reason: string): void {
  console.warn("[sofia:codex] Skipping MCP entry the engine cannot represent", { name, reason });
}

function strings(value: unknown[]): string[] {
  return value.filter((entry): entry is string => typeof entry === "string");
}

function stringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function tomlMap(value: Record<string, string>): string {
  return `{ ${Object.entries(value).map(([key, entry]) => `${tomlKey(key)} = ${tomlString(entry)}`).join(", ")} }`;
}

/** The SKILL.md docs paired with each runtime MCP server (the "prompt harness"
 * half of the capability). Written into `CODEX_HOME/skills/<name>/SKILL.md`. */
export function codexRuntimeSkill(name: "computer-use" | "browser"): string {
  if (name === "computer-use") {
    return [
      "---",
      "name: \"computer-use\"",
      "description: \"Control the macOS desktop through the computer-use MCP server (snapshot, click, type_text, press_key, scroll, set_value, perform_action, launch_app, open_url, clipboard, cua_*). Use when the task requires acting on real desktop applications or the web that cannot be done through the built-in browser or repo tools — e.g. opening a native app, interacting with a GUI the user can see, or completing a multi-step on-screen workflow. Never use it for tasks that are fully served by repo tools or the in-app browser.\"",
      "---",
      "",
      "# Computer Use (macOS)",
      "",
      "Use the `computer-use` MCP server's tools to observe and control the macOS desktop. The agent cannot see the screen; every action is driven from a snapshot, so always reason from the latest one.",
      "",
      "## Protocol",
      "",
      "1. Start with `snapshot` to get a screenshot plus a compact semantic AX state. Each element carries a ref like `{e1}` and center coordinates (`screenX`/`screenY` for absolute, `imageX`/`imageY` for the screenshot image).",
      "2. Act with refs where possible (`click` ref `{e1}`, `set_value`, `perform_action`); fall back to screenshot x/y coordinates only when no AX ref exists.",
      "3. After each action, take a fresh `snapshot` and compare the semantic state before acting again. Refs belong to the saved snapshot; save its snapshot_id and pass it with actions. If staleSnapshot is reported, recapture and resolve the intended control again.",
      "4. When `treeTruncated` is true, or a control you expected is missing from `elements`, page the snapshot you already have with `snapshot_elements` (`offset`, then `nextOffset` until null; or `query` by label/role). Paging reads the same snapshot, so refs stay valid and you do not invalidate your plan the way a second `snapshot` would.",
      "5. Use `type_text` for input, `press_key` for combos (`command+k`, `return`, `tab`, `escape`), `scroll` with a direction, and `wait` after actions that change UI.",
      "",
      "## Rules",
      "",
      "- Never read passwords or secrets from the clipboard unless the user explicitly asked; `clipboard_read` is allowed but treat content as sensitive.",
      "- Strict mode (default) keeps the user's frontmost app frontmost. Prefer it; only disable with `set_strict_mode` when a foreground interaction genuinely fails.",
      "- If `check_permissions` reports missing Accessibility or Screen Recording, surface the permission request to the user instead of retrying silently.",
      "- Foreground input is refused when the target app is not frontmost: activate the app, then take a new snapshot. Retrying the same refs will keep failing.",
      "- Accessibility accepting an action does not prove the UI changed. Confirm the result with a fresh `snapshot` before reporting success. `snapshot_elements` only pages the saved state; it cannot verify a later action.",
      "- Prefer `launch_app`/`open_url` for opening things over raw shortcuts.",
      "- Use click(button: right) for context menus; press_key(milliseconds: 0..5000) holds then releases the combo. Use snapshot(crop: {x,y,width,height}, image_width: 256..2048) to inspect a region in absolute screen points. The new image coordinates belong to that crop; discard old refs and coordinates.",
      "- After reconnecting, snapshot the original app by saved pid and window_title. A noSnapshot response means observations were lost, not that the app closed. Never relaunch an app to recover a tool handle. Missing controls may reflect delayed AX readiness: use snapshot(wait_for: label, wait_milliseconds: 0..5000) for bounded read-only polling, or wait briefly and capture again; do not replay mutations automatically.",
      "- The `cua_*` tools are compatibility aliases for screenshot-first loops; prefer the semantic `snapshot`/`click`/... surface for new work.",
      "- These tools are registered for every turn. If they are missing from your tool list, computer use is not available on this runtime: say so and stop instead of working around it. Do not substitute osascript/System Events, screencapture, cliclick, raw Swift, or another desktop driver. Missing tools require reconnecting Computer Use in Settings, not recreating it through shell commands.",
      "",
    ].join("\n");
  }
  return [
    "---",
    "name: \"browser\"",
    "description: \"Drive the built-in Sofia in-app browser through the Node REPL tool (mcp__node_repl__js) which exposes globalThis.agent.browsers. Use when the task requires browsing the web, filling forms, or inspecting a live page in a visible tab. Do not use it to interact with the Sofia itself.\"",
    "---",
    "",
    "# In-App Browser",
    "",
    "Call `mcp__node_repl__js` with JavaScript. Always initialize the runtime and read `browser.documentation()` before the first browser action in a fresh session.",
    "",
    "```js",
    "if (globalThis.agent?.browsers == null) globalThis.agent = await setupBrowserRuntime();",
    "if (globalThis.iab == null) {",
    "  globalThis.iab = await agent.browsers.get(\"iab\");",
    "  await iab.documentation();",
    "}",
    "globalThis.browser = globalThis.iab;",
    "console.log(await browser.tabs.list()); // plain {id,url,title} records",
    "globalThis.tab = await browser.tabs.get(\"the intended existing tab id\");",
    "globalThis.tabId = tab.id;",
    "// tabs.open(url) is only for an explicitly needed new tab.",
    "console.log(await tab.see()); // inspect before choosing an action",
    "// In a later call, act on an observed control, then inspect again.",
    "// display(await tab.screenshot()) emits an image when mixing outputs.",
    "```",
    "",
    "## Protocol",
    "",
    "1. `browser.tabs.list()` returns plain {id,url,title} metadata, not handles. Reacquire by the exact saved `tabId`; never recover using the first tab. Skip the Sofia UI tab.",
    "   `browser.user.openTabs()` is the equivalent user-session tab listing.",
    "2. `browser.tabs.get(id)` reacquires an existing tab without navigation (`tabs.attach(id)` is an alias). `browser.tabs.open(url)` creates a NEW visible tab; use it only when a new tab is needed.",
    "   Store reusable bindings as `globalThis.tab`/`globalThis.iab`. Local const/let bindings are scoped to one call. After a process restart reacquire the tab by ID; do not reload a partially filled form.",
    "   Undefined variables and unknown methods are JavaScript/API errors, not evidence that the browser bridge disconnected.",
    "3. Always `tab.snapshot()` before acting. After an action changes the page, take a fresh snapshot before choosing the next action.",
    "4. Prefer `tab.click({index})`/`tab.fill(target, value)`/`tab.type({text})`; use coordinates only when the semantic snapshot cannot identify the target.",
    "5. `tab.cdp.send(method, params)` is raw CDP on the tab if you need Page/Runtime/Network directly.",
    "6. `tab.evaluate(script)` runs a JavaScript **string** in the page and returns its value, awaiting promises. It takes a string, not a function and not an `{expression}` object: `await tab.evaluate(\"document.body.innerText\")`. Prefer `tab.snapshot()`/`tab.see()` to read page state and `tab.cdp.send` for protocol work; reach for `evaluate` only when neither can express the query.",
    "",
    "7. `tab.see({includeText:true,maxText:8000})` includes readable page text and frame metadata. Unknown options throw. Use `tab.frames.read({index})` for a missing message body; sandboxed srcdoc is inert source inspection, not a live frame context. Cross-origin frames without srcdoc report their limitation.",
    "8. Observations awaited without console.log/display are returned when there is no explicit output. When mixing outputs, print text with console.log and images with display(await tab.screenshot()). Page JavaScript exceptions are tool failures.",
    "",
    "## Rules",
    "",
    "- Never drive the Sofia's own tab (the page whose url is the Sofia UI).",
    "- The opened tab is already signed in to the user's session; do not attempt login again.",
    "- Keep discovery read-only: do not copy cookies or credentials.",
    "- Prefer `tab.goto(url)` to navigate instead of opening new tabs repeatedly.",
    "- Do not assume an action succeeded. Verify the resulting page state before continuing. `tab.see()` exposes non-password field values, validity, disabled/read-only and checked state. Use `tab.inputValue(target)` to verify entered text. When submission stalls, inspect `tab.network.responses()` and `tab.dev.logs()`; a successful click does not prove a server accepted the form.",
    "- Tool registration, model-visible discovery, and the live browser connection are separate states. A tool missing from the initial list does not prove the bridge failed.",
    "- If `mcp__node_repl__js` is not immediately visible, use the runtime tool discovery/search facility when available to find the node_repl js tool for Sofia Browser. Load the discovered tool and initialize setupBrowserRuntime() before deciding it is unavailable.",
    "- If discovery cannot expose the tool, report that the Browser tool is unavailable in this turn; do not claim the browser bridge crashed or that the user needs credentials. A previous unavailable turn is not evidence about this turn.",
    "- Only report a live bridge connection failure after a browser tool call returns that error. Describe the observed error; do not infer that the app restarted. Never reconnect to Chromium over raw CDP by hand.",
    "- Never substitute a separate browser process (Chrome, a browser harness) for the in-app browser. If the tool is callable now, proceed with the authorized browser work.",
    "",
  ].join("\n");
}

/** The MCP server each runtime skill documents. A skill is only written when
 * its server is registered, so the agent never reads docs for tools it cannot
 * call. */
const runtimeSkillServers: Record<"browser" | "computer-use", string> = {
  browser: "node_repl",
  "computer-use": "computer-use",
};

/** Write the runtime SKILL.md docs into `CODEX_HOME/skills/`, one per registered
 * MCP server. Returns the skill directories written. Best-effort: never throws
 * (caller ignores failures). */
export async function codexRuntimeSkillsFor(
  codexHome: string,
  servers: CodexRuntimeMcpServer[],
): Promise<string[]> {
  const written: string[] = [];
  const registered = new Set(servers.filter((server) => server.enabled !== false).map((server) => server.name));
  for (const name of ["computer-use", "browser"] as const) {
    const dir = join(codexHome, "skills", name);
    try {
      const { mkdir, rm, writeFile } = await import("node:fs/promises");
      if (!registered.has(runtimeSkillServers[name])) {
        // A skill left behind by an earlier run still teaches the agent tools
        // it cannot call, so docs for unregistered servers are removed too.
        await rm(dir, { recursive: true, force: true });
        continue;
      }
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "SKILL.md"), codexRuntimeSkill(name), "utf8");
      written.push(dir);
    } catch {
      // Best-effort: skills are an enhancement, not a hard dependency.
    }
  }
  return written;
}

/** Serialize `[mcp_servers.NAME]` tables into TOML. */
export function codexMcpServersToml(servers: CodexRuntimeMcpServer[]): string {
  const sections: string[] = [];
  for (const server of servers) {
    const lines = [`[mcp_servers.${tomlKey(server.name)}]`];
    if (server.command) lines.push(`command = ${tomlString(server.command)}`);
    if (server.url) lines.push(`url = ${tomlString(server.url)}`);
    if (server.httpHeaders) lines.push(`http_headers = ${tomlMap(server.httpHeaders)}`);
    if (server.startupTimeoutSec !== undefined) lines.push(`startup_timeout_sec = ${server.startupTimeoutSec}`);
    if (server.disabledTools) lines.push(`disabled_tools = ${JSON.stringify(server.disabledTools)}`);
    if (server.args && server.args.length > 0) {
      lines.push(`args = [${server.args.map((arg) => tomlString(arg)).join(", ")}]`);
    }
    if (server.cwd) lines.push(`cwd = ${tomlString(server.cwd)}`);
    if (server.defaultApprovalMode) {
      lines.push(`default_tools_approval_mode = ${tomlString(server.defaultApprovalMode)}`);
    }
    if (server.enabled !== undefined) lines.push(`enabled = ${server.enabled}`);
    if (server.enabledTools) {
      lines.push(`enabled_tools = [${server.enabledTools.map((tool) => tomlString(tool)).join(", ")}]`);
    }
    if (server.env && Object.keys(server.env).length > 0) {
      lines.push(`env = { ${Object.entries(server.env).map(([key, value]) => `${tomlKey(key)} = ${tomlString(value)}`).join(", ")} }`);
    }
    sections.push(lines.join("\n"));
  }
  return sections.length ? `${sections.join("\n\n")}\n` : "";
}

function tomlKey(value: string): string {
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : JSON.stringify(value);
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

/** The model-visible namespace the engine derives for an MCP server's tools.
 * It sanitizes every non-alphanumeric to `_` and prepends `mcp__`, so the
 * `computer-use` server's tools live under `mcp__computer_use`. */
export function codexRuntimeMcpToolNamespace(serverName: string): string {
  return `mcp__${serverName.replace(/[^A-Za-z0-9_]/g, "_")}`;
}

/**
 * Keep the runtime surfaces directly model-visible.
 *
 * Whenever the model supports `tool_search`, the engine DEFERS MCP tools: the
 * server is still registered, connected and callable, but its tools are absent
 * from the agent's tool list until it searches for them. The SKILL.md docs below
 * name their tools directly (`mcp__node_repl__js`), so a deferred server reads to
 * the agent as "this capability does not exist" and it improvises outside the app
 * (e.g. launching a separate Chrome instead of the in-app browser).
 * `direct_only_tool_namespaces` is the engine's supported knob for pinning a
 * namespace into the tool list instead.
 */
export function codexDirectToolNamespacesToml(servers: CodexRuntimeMcpServer[]): string {
  if (servers.length === 0) return "";
  const namespaces = servers.map((server) => codexRuntimeMcpToolNamespace(server.name));
  return `[features.code_mode]\ndirect_only_tool_namespaces = [${namespaces.map((namespace) => tomlString(namespace)).join(", ")}]\n`;
}

export function codexRuntimeSkillsDir(codexHome: string): string {
  return join(codexHome, "skills");
}

export const SOFIA_CODEX_HOME_DEFAULT = () => {
  const home = process.env.HOME?.trim() || homedir();
  return join(home, ".sofia");
};
