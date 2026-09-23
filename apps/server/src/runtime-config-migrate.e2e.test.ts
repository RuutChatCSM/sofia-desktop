import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startServer } from "./server.js";
import type { ServerConfig } from "./types.js";
import { readRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";

type Served = {
  port: number;
  stop: (closeActiveConnections?: boolean) => void | Promise<void>;
};

const CLIENT_TOKEN = "owt_runtime_migrate_client";
const HOST_TOKEN = "owt_runtime_migrate_host";
const stops: Array<() => void | Promise<void>> = [];
const roots: string[] = [];
const priorDataDir = process.env.SOFIA_DATA_DIR;
const priorTokenStore = process.env.SOFIA_TOKEN_STORE;

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function clientAuth() {
  return { authorization: `Bearer ${CLIENT_TOKEN}`, "content-type": "application/json" };
}

async function createTempRoot(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function startSofiaServer(workspaceRoot: string) {
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    configPath: join(workspaceRoot, "server.json"),
    token: CLIENT_TOKEN,
    hostToken: HOST_TOKEN,
    approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: ["*"],
    workspaces: [{ id: "ws_1", name: "Workspace", path: workspaceRoot, preset: "starter", workspaceType: "local" }],
    authorizedRoots: [workspaceRoot],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
  const server = await startServer(config) as Served;
  stops.push(() => server.stop(true));
  return { base: `http://127.0.0.1:${server.port}`, config };
}

beforeEach(async () => {
  const envRoot = await createTempRoot("sofia-runtime-migrate-env-");
  process.env.SOFIA_DATA_DIR = join(envRoot, "data");
  process.env.SOFIA_TOKEN_STORE = join(envRoot, "tokens.json");
});

afterEach(async () => {
  while (stops.length) {
    await stops.pop()?.();
  }
  while (roots.length) {
    await rm(roots.pop()!, { recursive: true, force: true });
  }
  if (priorDataDir === undefined) {
    delete process.env.SOFIA_DATA_DIR;
  } else {
    process.env.SOFIA_DATA_DIR = priorDataDir;
  }
  if (priorTokenStore === undefined) {
    delete process.env.SOFIA_TOKEN_STORE;
  } else {
    process.env.SOFIA_TOKEN_STORE = priorTokenStore;
  }
});

describe("runtime-config migrate route", () => {
  test("ignores a legacy project opencode.jsonc on the migrate route", async () => {
    const workspaceRoot = await createTempRoot("sofia-runtime-migrate-");
    await writeFile(
      join(workspaceRoot, "opencode.jsonc"),
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        mcp: {
          "nova-mail": { type: "remote", url: "https://example.com/mcp/mail", enabled: true },
        },
      }, null, 2) + "\n",
      "utf8",
    );

    const { base, config } = await startSofiaServer(workspaceRoot);

    const response = await fetch(`${base}/workspace/ws_1/runtime-config/migrate`, {
      method: "POST",
      headers: clientAuth(),
    });
    expect(response.status).toBe(200);

    const body = asRecord(await response.json());
    // Sofia no longer reads OpenCode config files, so there is nothing to lift.
    expect(body.migrated).toBe(false);
    expect(body.userOpencodeKeys).toEqual([]);

    const runtime = await readRuntimeOpencodeConfig(config, "ws_1");
    expect(runtime.mcp).toBeUndefined();

    // The legacy file is left exactly as the user wrote it.
    const parsed = asRecord(JSON.parse(await readFile(join(workspaceRoot, "opencode.jsonc"), "utf8")));
    expect(asRecord(parsed.mcp)?.["nova-mail"]).toBeDefined();
  });
});
