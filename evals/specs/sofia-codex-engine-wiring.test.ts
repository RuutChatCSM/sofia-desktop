import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { expect } from "vitest";
import { test } from "@sofia/testkit";

import { buildCodexConfigToml } from "../../apps/server/src/codex-config.ts";
import { buildSofiaDeveloperInstructions } from "../../apps/server/src/codex-prompt-harness.ts";
import { codexRuntimeSkill } from "../../apps/server/src/codex-runtime-mcp.ts";
import {
  clearCdpBrokerDiscovery,
  writeCdpBrokerDiscovery,
} from "../../apps/desktop/electron/cdp-broker-discovery.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../..");

test("Sofia preserves native engine behavior while wiring multi-provider and browser capabilities", async () => {
  const context = buildSofiaDeveloperInstructions({ workspaceId: "workspace-1", cwd: "/repo" });
  expect(context).toContain("<sofia_context>");
  expect(context).not.toMatch(/Sofia App|Codex/);
  expect(context).toContain("Working directory: /repo");
  expect(context).not.toMatch(/make a short plan|execute it back-to-back|report the outcome in one line/i);

  const config = buildCodexConfigToml({
    openai: {
      name: "OpenAI",
      npm: "@ai-sdk/openai",
      api: "https://api.openai.com/v1",
      env: ["OPENAI_API_KEY"],
    },
    xiaomi: {
      name: "Xiaomi MiMo",
      npm: "@ai-sdk/openai-compatible",
      api: "https://api.xiaomimimo.com/v1",
      env: ["XIAOMI_API_KEY"],
    },
  });
  expect(config).toContain("[model_providers.openai]");
  expect(config).toContain("[model_providers.xiaomi]");
  expect(config).toMatch(/\[model_providers\.openai\][\s\S]*?wire_api = "responses"/);
  expect(config).toMatch(/\[model_providers\.xiaomi\][\s\S]*?wire_api = "chatcompletions"/);

  const browserSkill = codexRuntimeSkill("browser");
  expect(browserSkill).toContain("mcp__node_repl__js");
  expect(browserSkill).toContain("browser.documentation()");
  expect(browserSkill).toContain("take a fresh snapshot");
  // The skill must tell the agent what a dead bridge means, otherwise it
  // improvises with raw CDP instead of reporting.
  expect(browserSkill).toContain("in-app browser bridge is not answering");

  const sourceAsset = path.join(repoRoot, "apps/server/src/sofia-browser-repl.mjs");
  await access(sourceAsset);
  const packageJson = JSON.parse(await readFile(path.join(repoRoot, "apps/server/package.json"), "utf8"));
  expect(packageJson.scripts.build).toContain("build:runtime-assets");
});

/** Enough of the desktop CDP-broker HTTP surface for the harness to resolve it. */
async function startStubBridge() {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url ?? "");
    res.setHeader("content-type", "application/json");
    res.end(req.url?.startsWith("/json/version") ? JSON.stringify({ webSocketDebuggerUrl: "ws://127.0.0.1:1/devtools/browser/stub" }) : "[]");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("stub bridge did not bind a port");
  return { url: `http://127.0.0.1:${address.port}`, requests, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

/** Drive the real harness the way the engine does: stdio JSON-RPC, one `js` call. */
function callHarness({ brokerUrl, sofiaHome, code }: { brokerUrl: string; sofiaHome: string; code: string }) {
  const child = spawn(process.execPath, [path.join(repoRoot, "apps/server/src/sofia-browser-repl.mjs")], {
    env: { ...process.env, SOFIA_BROWSER_CDP_URL: brokerUrl, SOFIA_HOME: sofiaHome },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const reply = new Promise<{ result?: { content: { text: string }[] }; error?: { message: string } }>((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("harness did not answer within 20s")), 20_000);
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        const message = JSON.parse(line) as { id?: number; result?: unknown; error?: { message: string } };
        if (message.id === 2) {
          clearTimeout(timer);
          resolve(message as never);
        }
        index = buffer.indexOf("\n");
      }
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "js", arguments: { code } } })}\n`);
  });
  return { reply, kill: () => child.kill("SIGTERM") };
}

test("the in-app browser tool survives the stale registration the engine writes", async () => {
  // `config.toml` records an ephemeral broker port and every build rewrites that
  // shared file, so the URL the harness is started with routinely belongs to a
  // Sofia App window that has since closed. It used to hang there.
  const home = await mkdtemp(path.join(tmpdir(), "sofia-wiring-"));
  const stale = callHarness({
    brokerUrl: "http://127.0.0.1:59558",
    sofiaHome: home,
    code: "const b = await setupBrowserRuntime(); return await b.browsers.get('iab').tabs.list();",
  });
  try {
    const failure = await stale.reply;
    expect(failure.error?.message).toContain("in-app browser bridge is not answering");
    expect(failure.error?.message).toContain("http://127.0.0.1:59558");
  } finally {
    stale.kill();
  }

  // The live app publishes its endpoint, exactly as the desktop does on start.
  const bridge = await startStubBridge();
  const recovering = callHarness({
    brokerUrl: "http://127.0.0.1:59558",
    sofiaHome: home,
    code: "const b = await setupBrowserRuntime(); return await b.browsers.get('iab').tabs.list();",
  });
  try {
    await writeCdpBrokerDiscovery({ sofiaHome: home, url: bridge.url, appIdentifier: "app.sofia.desktop.dev", pid: process.pid });
    const recovered = await recovering.reply;
    expect(recovered.result?.content).toEqual([{ type: "text", text: "[]" }]);
    expect(bridge.requests).toContain("/json/list");
  } finally {
    recovering.kill();
    await clearCdpBrokerDiscovery({ sofiaHome: home });
    await bridge.close();
    await rm(home, { recursive: true, force: true });
  }
});
