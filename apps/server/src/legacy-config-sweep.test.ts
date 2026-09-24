import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "jsonc-parser";

import {
  legacySweepStatePath,
  readLegacyConfigSweepState,
  sweepLegacySofiaConfig,
} from "./legacy-config-sweep.js";
import type { ServerConfig } from "./types.js";

const roots: string[] = [];
const NOW = new Date("2026-07-15T12:34:56Z");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function createRoot() {
  const root = await mkdtemp(join(tmpdir(), "sofia-legacy-config-sweep-"));
  roots.push(root);
  return root;
}

function configFor(root: string): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    configPath: join(root, "server.json"),
    token: "owt_legacy_sweep_client",
    hostToken: "owt_legacy_sweep_host",
    approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: ["*"],
    workspaces: [{ id: "ws_1", name: "Workspace", path: root, preset: "starter", workspaceType: "local" }],
    authorizedRoots: [root],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
}

function legacyDir(root: string): string {
  return join(root, ".config", "engine");
}

async function writeLegacyFile(root: string, name: string, content: string): Promise<string> {
  await mkdir(legacyDir(root), { recursive: true });
  const path = join(legacyDir(root), name);
  await writeFile(path, content, "utf8");
  return path;
}

async function countBackups(root: string, name: string): Promise<number> {
  const entries = await readdir(legacyDir(root));
  return entries.filter((entry) => entry.startsWith(`${name}.sofia-backup-`)).length;
}

function parseRecord(content: string): Record<string, unknown> {
  const parsed: unknown = parse(content);
  return isRecord(parsed) ? parsed : {};
}

afterEach(async () => {
  while (roots.length) {
    const root = roots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe("legacy Sofia engine config sweep", () => {
  test("removes only Sofia-managed legacy keys and preserves user content", async () => {
    const root = await createRoot();
    const config = configFor(root);
    const original = `{
  // user MCP comment
  "mcp": {
    "my-notion": { "type": "remote", "url": "https://notion.example/mcp" },
    "sofia-cloud": { "type": "remote", "url": "https://cloud.example/mcp" }
  },
  "agent": {
    "sofia": { "mode": "primary" },
    "user-agent": { "mode": "subagent" }
  },
  "default_agent": "sofia",
  "plugin": [
    "user-plugin",
    "/tmp/engine-plugins/sofia-office-attachments.js",
    "sofia-capabilities-knowledge"
  ],
  "userSetting": true
}
`;
    const path = await writeLegacyFile(root, "engine.jsonc", original);

    const state = await sweepLegacySofiaConfig(config, { homeDir: root, now: NOW });
    const after = await readFile(path, "utf8");
    const parsed = parseRecord(after);
    const mcp = isRecord(parsed.mcp) ? parsed.mcp : {};
    const agent = isRecord(parsed.agent) ? parsed.agent : {};
    const plugin = Array.isArray(parsed.plugin) ? parsed.plugin : [];

    expect(after).toContain("// user MCP comment");
    expect(mcp["my-notion"]).toEqual({ type: "remote", url: "https://notion.example/mcp" });
    expect(mcp["sofia-cloud"]).toBeUndefined();
    expect(agent["user-agent"]).toEqual({ mode: "subagent" });
    expect(agent.sofia).toBeUndefined();
    expect(parsed.default_agent).toBeUndefined();
    expect(plugin).toEqual(["user-plugin"]);
    expect(parsed.userSetting).toBe(true);

    const sweptFile = state.files.find((entry) => entry.path === path);
    expect(sweptFile?.removedKeys).toEqual(["mcp.sofia-cloud", "agent.sofia", "default_agent", "plugin"]);
    expect(typeof sweptFile?.backupPath).toBe("string");
    if (sweptFile?.backupPath) {
      expect(await readFile(sweptFile.backupPath, "utf8")).toBe(original);
    }

    const storedState = await readLegacyConfigSweepState(config);
    expect(storedState?.files.length).toBe(1);
  });

  test("skips after a successful first run", async () => {
    const root = await createRoot();
    const config = configFor(root);
    const path = await writeLegacyFile(root, "config.json", `{ "default_agent": "sofia" }\n`);

    await sweepLegacySofiaConfig(config, { homeDir: root, now: NOW });
    const contentAfterFirstRun = await readFile(path, "utf8");
    const backupsAfterFirstRun = await countBackups(root, "config.json");
    const stateAfterFirstRun = await readFile(legacySweepStatePath(config), "utf8");

    await sweepLegacySofiaConfig(config, { homeDir: root, now: new Date("2026-07-15T13:00:00Z") });

    expect(await readFile(path, "utf8")).toBe(contentAfterFirstRun);
    expect(await countBackups(root, "config.json")).toBe(backupsAfterFirstRun);
    expect(await readFile(legacySweepStatePath(config), "utf8")).toBe(stateAfterFirstRun);
  });

  test("leaves files without Sofia-managed keys untouched", async () => {
    const root = await createRoot();
    const config = configFor(root);
    const original = `{
  // keep this file exactly
  "mcp": { "my-notion": { "type": "remote" } },
  "plugin": ["user-plugin"]
}
`;
    const path = await writeLegacyFile(root, "engine.json", original);

    const state = await sweepLegacySofiaConfig(config, { homeDir: root, now: NOW });

    expect(await readFile(path, "utf8")).toBe(original);
    expect(await countBackups(root, "engine.json")).toBe(0);
    expect(state.files.find((entry) => entry.path === path)?.removedKeys).toEqual([]);
  });

  test("records errors without throwing and aborts remaining edits", async () => {
    const root = await createRoot();
    const config = configFor(root);
    const safePath = await writeLegacyFile(root, "config.json", `{ "plugin": ["user-plugin"] }\n`);
    const unwritablePath = await writeLegacyFile(root, "engine.json", `{ "default_agent": "sofia" }\n`);
    const remainingPath = await writeLegacyFile(root, "engine.jsonc", `{ "default_agent": "sofia" }\n`);
    await chmod(unwritablePath, 0o444);

    const state = await sweepLegacySofiaConfig(config, { homeDir: root, now: NOW });

    expect(state.error).toBeTruthy();
    expect(await readFile(safePath, "utf8")).toBe(`{ "plugin": ["user-plugin"] }\n`);
    expect(await readFile(unwritablePath, "utf8")).toBe(`{ "default_agent": "sofia" }\n`);
    expect(await readFile(remainingPath, "utf8")).toBe(`{ "default_agent": "sofia" }\n`);
    expect((await readLegacyConfigSweepState(config))?.error).toBeTruthy();
  });
});
