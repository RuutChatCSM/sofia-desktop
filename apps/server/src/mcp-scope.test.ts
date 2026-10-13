import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { addMcp, listMcp, removeMcp, setMcpEnabled } from "./mcp.js";
import { readEffectiveRuntimeWorkspaceEngineConfig } from "./runtime-engine-config-store.js";
import type { ServerConfig } from "./types.js";

const WORKSPACE_ID = "ws_scope_test";

function serverConfig(root: string): ServerConfig {
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
  const root = await mkdtemp(join(tmpdir(), "sofia-mcp-scope-"));
  const previousDb = process.env.SOFIA_RUNTIME_DB;
  const previousEngineConfigDir = process.env.SOFIA_ENGINE_CONFIG_DIR;
  process.env.SOFIA_RUNTIME_DB = join(root, "runtime.sqlite");
  process.env.SOFIA_ENGINE_CONFIG_DIR = join(root, "global-engine");
  await mkdir(process.env.SOFIA_ENGINE_CONFIG_DIR, { recursive: true });
  try {
    await fn({ root, config: serverConfig(root) });
  } finally {
    if (previousDb === undefined) delete process.env.SOFIA_RUNTIME_DB;
    else process.env.SOFIA_RUNTIME_DB = previousDb;
    if (previousEngineConfigDir === undefined) delete process.env.SOFIA_ENGINE_CONFIG_DIR;
    else process.env.SOFIA_ENGINE_CONFIG_DIR = previousEngineConfigDir;
    await rm(root, { recursive: true, force: true });
  }
}

describe("MCP install scope", () => {
  test("a global entry is stored once and inherited by the workspace", async () => {
    await withWorkspace(async ({ root, config }) => {
      await addMcp(config, WORKSPACE_ID, "shared", { type: "remote", url: "https://global.example/mcp" }, "global");

      const items = await listMcp(config, WORKSPACE_ID, root);
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ name: "shared", scope: "global" });

      const effective = await readEffectiveRuntimeWorkspaceEngineConfig(config, WORKSPACE_ID);
      expect(effective.mcp?.shared).toMatchObject({ url: "https://global.example/mcp" });
    });
  });

  test("a project entry overrides a global entry of the same name", async () => {
    await withWorkspace(async ({ root, config }) => {
      await addMcp(config, WORKSPACE_ID, "shared", { type: "remote", url: "https://global.example/mcp" }, "global");
      await addMcp(config, WORKSPACE_ID, "shared", { type: "remote", url: "https://project.example/mcp" }, "project");

      const items = await listMcp(config, WORKSPACE_ID, root);
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ name: "shared", scope: "project" });
      expect(items[0]?.config).toMatchObject({ url: "https://project.example/mcp" });
    });
  });

  test("defaults to the project layer", async () => {
    await withWorkspace(async ({ root, config }) => {
      await addMcp(config, WORKSPACE_ID, "local-only", { type: "local", command: ["mcp-server"] });
      const items = await listMcp(config, WORKSPACE_ID, root);
      expect(items[0]).toMatchObject({ name: "local-only", scope: "project" });
    });
  });

  test("removes and toggles within the requested scope only", async () => {
    await withWorkspace(async ({ root, config }) => {
      await addMcp(config, WORKSPACE_ID, "shared", { type: "remote", url: "https://global.example/mcp" }, "global");
      await addMcp(config, WORKSPACE_ID, "shared", { type: "remote", url: "https://project.example/mcp" }, "project");

      expect(await setMcpEnabled(config, WORKSPACE_ID, "shared", false, "project")).toBe(true);
      let items = await listMcp(config, WORKSPACE_ID, root);
      expect(items[0]?.config).toMatchObject({ enabled: false });

      expect(await removeMcp(config, WORKSPACE_ID, "shared", "global")).toBe(true);
      expect(await removeMcp(config, WORKSPACE_ID, "shared", "global")).toBe(false);
      expect(await removeMcp(config, WORKSPACE_ID, "shared", "project")).toBe(true);
      items = await listMcp(config, WORKSPACE_ID, root);
      expect(items).toHaveLength(0);
    });
  });
});
