import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addMcp, listMcp, setMcpEnabled } from "./mcp.js";
import { buildSofiaRuntimeConfigObject } from "./sofia-runtime-config.js";
import { readSofiaWorkspaceConfig } from "./sofia-workspace-config-store.js";
import { addPlugin, listPlugins, removePlugin } from "./plugins.js";
import {
  onRuntimeWorkspaceEngineConfigWrite,
  readRuntimeWorkspaceEngineConfig,
  writeRuntimeWorkspaceEngineConfig,
} from "./runtime-engine-config-store.js";
import { startServer } from "./server.js";
import type { ServerConfig } from "./types.js";

const WORKSPACE_ID = "ws_runtime_test";

type Served = {
  port: number;
  stop: (closeActiveConnections?: boolean) => void | Promise<void>;
};

function serverConfig(root: string, dbPath: string): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    token: "token",
    hostToken: "host-token",
    configPath: join(root, "server.json"),
    approval: { mode: "auto", timeoutMs: 0 },
    corsOrigins: [],
    workspaces: [{ id: WORKSPACE_ID, name: "Test", path: root, preset: "starter", workspaceType: "local" }],
    authorizedRoots: [root],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "generated",
    hostTokenSource: "generated",
    logFormat: "pretty",
    logRequests: false,
  } satisfies ServerConfig;
}

async function withWorkspace(fn: (input: { root: string; config: ServerConfig }) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "sofia-runtime-config-"));
  const previousDb = process.env.SOFIA_RUNTIME_DB;
  const previousWorkspaceEngineConfigDir = process.env.SOFIA_ENGINE_CONFIG_DIR;
  const dbPath = join(root, "runtime.sqlite");
  process.env.SOFIA_RUNTIME_DB = dbPath;
  // MCP listings merge the global Sofia engine config layer, so point it at an
  // empty directory inside the fixture. Without this the assertions observe
  // whatever MCP servers the developer happens to have in ~/.config/engine.
  process.env.SOFIA_ENGINE_CONFIG_DIR = join(root, "global-engine");
  await mkdir(process.env.SOFIA_ENGINE_CONFIG_DIR, { recursive: true });
  try {
    await fn({ root, config: serverConfig(root, dbPath) });
  } finally {
    if (previousDb === undefined) delete process.env.SOFIA_RUNTIME_DB;
    else process.env.SOFIA_RUNTIME_DB = previousDb;
    if (previousWorkspaceEngineConfigDir === undefined) delete process.env.SOFIA_ENGINE_CONFIG_DIR;
    else process.env.SOFIA_ENGINE_CONFIG_DIR = previousWorkspaceEngineConfigDir;
    await rm(root, { recursive: true, force: true });
  }
}

async function expectMissing(path: string): Promise<void> {
  await expect(stat(path)).rejects.toThrow();
}

describe("runtime Sofia engine config store", () => {
  test("reports no-op writes without notifying listeners", async () => {
    await withWorkspace(async ({ config }) => {
      let writes = 0;
      const unsubscribe = onRuntimeWorkspaceEngineConfigWrite((writtenConfig, workspaceId) => {
        if (writtenConfig === config && workspaceId === WORKSPACE_ID) {
          writes += 1;
        }
      });

      try {
        const first = await writeRuntimeWorkspaceEngineConfig(config, WORKSPACE_ID, (current) => ({
          ...current,
          mcp: { posthog: { type: "remote", url: "https://mcp.posthog.com/mcp", enabled: true } },
        }));
        expect(first.changed).toBe(true);
        expect(writes).toBe(1);

        const second = await writeRuntimeWorkspaceEngineConfig(config, WORKSPACE_ID, (current) => ({
          ...current,
          mcp: { posthog: { type: "remote", url: "https://mcp.posthog.com/mcp", enabled: true } },
        }));
        expect(second.changed).toBe(false);
        expect(second.config).toEqual(first.config);
        expect(writes).toBe(1);

        const third = await writeRuntimeWorkspaceEngineConfig(config, WORKSPACE_ID, (current) => ({
          ...current,
          mcp: { posthog: { type: "remote", url: "https://mcp.posthog.com/mcp", enabled: false } },
        }));
        expect(third.changed).toBe(true);
        expect(writes).toBe(2);
      } finally {
        unsubscribe();
      }
    });
  });

  test("stores MCP changes in the Sofia App runtime DB without rewriting workspace files", async () => {
    await withWorkspace(async ({ root, config }) => {
      await addMcp(config, WORKSPACE_ID, "runtime", { type: "remote", url: "https://runtime.example/mcp", enabled: true });
      await setMcpEnabled(config, WORKSPACE_ID, "runtime", false);

      await expectMissing(join(root, "engine.jsonc"));
      await expectMissing(join(root, ".sofia", "sofia.json"));
      expect((await readRuntimeWorkspaceEngineConfig(config, WORKSPACE_ID)).mcp?.runtime?.enabled).toBe(false);

      const items = await listMcp(config, WORKSPACE_ID, root);
      expect(items.map((item) => `${item.name}:${item.source}`)).toEqual(["runtime:config.remote"]);
    });
  });

  test("stores plugin changes in the Sofia App runtime DB without rewriting workspace files", async () => {
    await withWorkspace(async ({ root, config }) => {
      expect(await addPlugin(config, WORKSPACE_ID, "runtime-plugin")).toBe(true);
      expect(await removePlugin(config, WORKSPACE_ID, "runtime-plugin")).toBe(true);
      expect(await addPlugin(config, WORKSPACE_ID, "runtime-plugin")).toBe(true);

      await expectMissing(join(root, "engine.jsonc"));
      await expectMissing(join(root, ".sofia", "sofia.json"));
      expect((await readRuntimeWorkspaceEngineConfig(config, WORKSPACE_ID)).plugin).toEqual(["runtime-plugin"]);

      const result = await listPlugins(config, WORKSPACE_ID, root, false);
      expect(result.items.map((item) => item.spec)).toEqual(["runtime-plugin"]);

      await addMcp(config, WORKSPACE_ID, "runtime", { type: "remote", url: "https://runtime.example/mcp", enabled: true });
      const runtimeConfig = await buildSofiaRuntimeConfigObject(config, WORKSPACE_ID) as {
        plugin?: string[];
        mcp?: Record<string, Record<string, unknown>>;
      };
      expect(runtimeConfig.plugin).toContain("runtime-plugin");
      expect(runtimeConfig.mcp?.runtime?.url).toBe("https://runtime.example/mcp");
    });
  });

  test("malformed user engine config does not block runtime config reads", async () => {
    await withWorkspace(async ({ root, config }) => {
      await writeFile(join(root, "engine.jsonc"), '{ "mcp": {\n}\n}\n}\n', "utf8");
      await addMcp(config, WORKSPACE_ID, "runtime", { type: "remote", url: "https://runtime.example/mcp", enabled: true });
      await addPlugin(config, WORKSPACE_ID, "runtime-plugin");

      const mcpItems = await listMcp(config, WORKSPACE_ID, root);
      const pluginItems = await listPlugins(config, WORKSPACE_ID, root, false);

      expect(mcpItems.map((item) => item.name)).toEqual(["runtime"]);
      expect(pluginItems.items.map((item) => item.spec)).toEqual(["runtime-plugin"]);
    });
  });

  test("stores Sofia-owned workspace config in the runtime DB without writing legacy files", async () => {
    await withWorkspace(async ({ root, config }) => {
      const server = await startServer(config) as Served;
      try {
        const response = await fetch(`http://127.0.0.1:${server.port}/workspace/${WORKSPACE_ID}/config`, {
          method: "PATCH",
          headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
          body: JSON.stringify({
            sofia: {
              cloudImports: {
                plugins: {
                  plugin_1: { pluginId: "plugin_1", name: "productivity", files: [] },
                },
              },
            },
          }),
        });
        expect(response.status).toBe(200);

        const legacySofiaPath = join(root, ".sofia", "sofia.json");
        const legacySofia = await readFile(legacySofiaPath, "utf8").catch(() => "");
        expect(legacySofia).not.toContain("productivity");
        expect(legacySofia).not.toContain("cloudImports");
        expect((await readSofiaWorkspaceConfig(config, WORKSPACE_ID)).cloudImports).toEqual({
          plugins: {
            plugin_1: { pluginId: "plugin_1", name: "productivity", files: [] },
          },
        });

        const configResponse = await fetch(`http://127.0.0.1:${server.port}/workspace/${WORKSPACE_ID}/config`, {
          headers: { authorization: `Bearer ${config.token}` },
        });
        expect(configResponse.status).toBe(200);
        expect(await configResponse.json()).toMatchObject({
          sofia: {
            cloudImports: {
              plugins: {
                plugin_1: { pluginId: "plugin_1", name: "productivity", files: [] },
              },
            },
          },
        });
      } finally {
        await server.stop(true);
      }
    });
  });

  test("runtime config status reports the Sofia App-managed sources the settings UI renders", async () => {
    await withWorkspace(async ({ root, config }) => {
      await addMcp(config, WORKSPACE_ID, "runtime", { type: "remote", url: "https://runtime.example/mcp" });

      const server = await startServer(config) as Served;
      try {
        const response = await fetch(`http://127.0.0.1:${server.port}/workspace/${WORKSPACE_ID}/runtime-config`, {
          headers: { authorization: `Bearer ${config.token}` },
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          sources: {
            runtimeDatabase: {
              keys: ["mcp"],
              config: { mcp: { runtime: { type: "remote", url: "https://runtime.example/mcp" } } },
            },
            injected: { keys: expect.arrayContaining(["mcp"]) },
          },
          legacySofia: {
            path: join(root, ".sofia", "sofia.json"),
            keys: [],
            error: null,
          },
        });
      } finally {
        await server.stop(true);
      }
    });
  });

  test("runtime config status tolerates malformed legacy Sofia App metadata", async () => {
    await withWorkspace(async ({ root, config }) => {
      await mkdir(join(root, ".sofia"), { recursive: true });
      await writeFile(join(root, ".sofia", "sofia.json"), "{ invalid\n", "utf8");
      await addMcp(config, WORKSPACE_ID, "runtime", { type: "remote", url: "https://runtime.example/mcp" });

      const server = await startServer(config) as Served;
      try {
        const response = await fetch(`http://127.0.0.1:${server.port}/workspace/${WORKSPACE_ID}/runtime-config`, {
          headers: { authorization: `Bearer ${config.token}` },
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          runtimeKeys: ["mcp"],
          legacySofia: { keys: [], error: null },
        });
      } finally {
        await server.stop(true);
      }
    });
  });

});
