import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { addMcp } from "./mcp.js";
import { writeCodexProviders } from "./codex-providers.js";
import {
  applyCodexWorkspaceMcpConfiguration,
  codexWorkspaceConfigFile,
  setCodexBinaryForConfig,
} from "./codex-registry.js";
import type { ServerConfig } from "./types.js";

const WORKSPACE_ID = "ws_codex_registry_test";

function serverConfig(root: string): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    token: "token",
    hostToken: "host-token",
    configPath: join(root, "server.json"),
    approval: { mode: "auto", timeoutMs: 0 },
    corsOrigins: [],
    workspaces: [{ id: WORKSPACE_ID, name: "Test", path: join(root, "ws"), preset: "starter", workspaceType: "local" }],
    authorizedRoots: [root],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "generated",
    hostTokenSource: "generated",
    logFormat: "pretty",
    logRequests: false,
  } satisfies ServerConfig;
}

/** Isolate every path the codex config generation reads or writes. */
async function withCodexWorkspace(
  fn: (input: { root: string; config: ServerConfig; home: string; configFile: string }) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "sofia-codex-registry-"));
  const home = join(root, "home");
  const previous = {
    db: process.env.SOFIA_RUNTIME_DB,
    engineConfigDir: process.env.SOFIA_ENGINE_CONFIG_DIR,
    sofiaHome: process.env.SOFIA_HOME,
    providerHome: process.env.SOFIA_PROVIDER_HOME,
  };
  process.env.SOFIA_RUNTIME_DB = join(root, "runtime.sqlite");
  process.env.SOFIA_ENGINE_CONFIG_DIR = join(root, "global-engine");
  // codexHomeFor/codexHomeDir pin on SOFIA_HOME, so the engine's config,
  // skills and provider catalog all land inside the fixture.
  process.env.SOFIA_HOME = home;
  delete process.env.SOFIA_PROVIDER_HOME;
  await mkdir(process.env.SOFIA_ENGINE_CONFIG_DIR, { recursive: true });
  await mkdir(join(root, "ws"), { recursive: true });
  await mkdir(home, { recursive: true });
  const config = serverConfig(root);
  try {
    await fn({ root, config, home, configFile: codexWorkspaceConfigFile(config, WORKSPACE_ID) });
  } finally {
    for (const [key, value] of [
      ["SOFIA_RUNTIME_DB", previous.db],
      ["SOFIA_ENGINE_CONFIG_DIR", previous.engineConfigDir],
      ["SOFIA_HOME", previous.sofiaHome],
      ["SOFIA_PROVIDER_HOME", previous.providerHome],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
}

/** Two connected providers, in the order the app pushed them. */
async function seedProviders(): Promise<void> {
  await writeCodexProviders({
    providers: {
      xiaomi: { api_key: "k", base_url: "https://api.xiaomimimo.com/v1", wire_api: "chatcompletions", name: "Xiaomi", models: [{ id: "mimo", name: "MiMo", reasoning: false }] },
      deepseek: { api_key: "k", base_url: "https://api.deepseek.com/v1", wire_api: "chatcompletions", name: "DeepSeek", models: [{ id: "deepseek-flash", name: "DeepSeek Flash", reasoning: false }] },
    },
  });
}

describe("codex workspace engine configuration", () => {
  test("writes the MCP servers the app saved into the workspace engine config", async () => {
    await withCodexWorkspace(async ({ config, configFile }) => {
      setCodexBinaryForConfig(config, { path: "/bin/true", source: "custom" });
      // What "Connect Computer Use MCP" stores in the workspace.
      await addMcp(config, WORKSPACE_ID, "computer-use", {
        type: "local",
        command: ["/helpers/Sofia Computer Use.app/Contents/MacOS/ComputerUse", "mcp"],
        enabled: true,
      });

      await applyCodexWorkspaceMcpConfiguration(config, WORKSPACE_ID);

      expect(existsSync(configFile)).toBe(true);
      const toml = await readFile(configFile, "utf8");
      expect(toml).toContain("[mcp_servers.computer-use]");
      expect(toml).toContain('command = "/helpers/Sofia Computer Use.app/Contents/MacOS/ComputerUse"');
      expect(toml).toContain('args = ["mcp"]');
      // Without the pin the engine defers MCP tools behind tool_search and the
      // agent never sees mcp__computer_use__*.
      expect(toml).toContain("mcp__computer_use");
    });
  });

  test("keeps the workspace's selected provider and model across regeneration", async () => {
    await withCodexWorkspace(async ({ config, configFile }) => {
      setCodexBinaryForConfig(config, { path: "/bin/true", source: "custom" });
      await seedProviders();

      await applyCodexWorkspaceMcpConfiguration(config, WORKSPACE_ID);
      // No selection stored yet, so the first connected provider wins.
      expect(await readFile(configFile, "utf8")).toContain('model_provider = "xiaomi"');

      // The user picks DeepSeek; the engine config is where that choice lives.
      const picked = (await readFile(configFile, "utf8"))
        .replace('model_provider = "xiaomi"', 'model_provider = "deepseek"')
        .replace('model = "mimo"', 'model = "deepseek-flash"');
      await writeFile(configFile, picked, "utf8");

      await applyCodexWorkspaceMcpConfiguration(config, WORKSPACE_ID);

      const regenerated = await readFile(configFile, "utf8");
      expect(regenerated).toContain('model_provider = "deepseek"');
      expect(regenerated).toContain('model = "deepseek-flash"');
    });
  });
});
