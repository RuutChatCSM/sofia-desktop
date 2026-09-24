import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildSofiaRuntimeConfigObject } from "./sofia-runtime-config.js";
import {
  mergeRuntimeProviderUpdate,
  readGlobalRuntimeWorkspaceEngineConfig,
  runtimeProviderMap,
  writeGlobalRuntimeWorkspaceEngineConfig,
} from "./runtime-engine-config-store.js";
import { startServer } from "./server.js";
import type { ServerConfig } from "./types.js";

const CLIENT_TOKEN = "owt_global_provider_client";
const HOST_TOKEN = "owt_global_provider_host";
const roots: string[] = [];
const stops: Array<() => void | Promise<void>> = [];
let previousRuntimeDb: string | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function providerFromPayload(payload: Record<string, unknown>): Record<string, unknown> {
  return isRecord(payload.provider) ? payload.provider : {};
}

function clientHeaders() {
  return { authorization: `Bearer ${CLIENT_TOKEN}`, "content-type": "application/json" };
}

function hostHeaders() {
  return { "x-sofia-host-token": HOST_TOKEN, "content-type": "application/json" };
}

async function readJsonObject(response: Response): Promise<Record<string, unknown>> {
  const payload: unknown = await response.json();
  if (!isRecord(payload)) throw new Error("Expected JSON object");
  return payload;
}

async function createTempRoot() {
  const root = await mkdtemp(join(tmpdir(), "sofia-global-providers-"));
  roots.push(root);
  previousRuntimeDb = process.env.SOFIA_RUNTIME_DB;
  process.env.SOFIA_RUNTIME_DB = join(root, "runtime.sqlite");
  return root;
}

function serverConfig(root: string, baseUrl?: string): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    configPath: join(root, "server.json"),
    token: CLIENT_TOKEN,
    hostToken: HOST_TOKEN,
    approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: ["*"],
    workspaces: [{ id: "ws_1", name: "Workspace", path: root, preset: "starter", workspaceType: "local", baseUrl }],
    authorizedRoots: [root],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  } satisfies ServerConfig;
}

afterEach(async () => {
  while (stops.length) await stops.pop()?.();
  while (roots.length) {
    const root = roots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
  if (previousRuntimeDb === undefined) delete process.env.SOFIA_RUNTIME_DB;
  else process.env.SOFIA_RUNTIME_DB = previousRuntimeDb;
});

describe("global runtime providers", () => {
  test("round-trips provider upserts and null deletes into the engine config", async () => {
    const root = await createTempRoot();
    const config = serverConfig(root);
    const anthropic = { id: "anthropic", name: "Anthropic", env: ["ANTHROPIC_API_KEY"] };
    const openrouter = { id: "openrouter", name: "OpenRouter", env: ["OPENROUTER_API_KEY"] };

    await writeGlobalRuntimeWorkspaceEngineConfig(config, (current) => ({
      ...current,
      provider: mergeRuntimeProviderUpdate(current.provider, { lpr_anthropic: anthropic }),
    }));
    await writeGlobalRuntimeWorkspaceEngineConfig(config, (current) => ({
      ...current,
      provider: mergeRuntimeProviderUpdate(current.provider, { lpr_openrouter: openrouter, lpr_anthropic: null }),
    }));

    const globalRuntime = await readGlobalRuntimeWorkspaceEngineConfig(config);
    expect(runtimeProviderMap(globalRuntime)).toEqual({ lpr_openrouter: openrouter });

    const engineConfig = await buildSofiaRuntimeConfigObject(config, "ws_1");
    expect(providerFromPayload(engineConfig)).toEqual({ lpr_openrouter: openrouter });
  });

  test("global provider route reloads only when the effective engine config changes", async () => {
    const root = await createTempRoot();
    const engineRequests: string[] = [];
    const config = serverConfig(root);
    const engine = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        engineRequests.push(`${request.method} ${url.pathname}`);
        if (request.method === "POST" && url.pathname === "/instance/dispose") {
          return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
        }
        if (request.method === "GET" && url.pathname === "/config") {
          const content = JSON.stringify(await buildSofiaRuntimeConfigObject(config, "ws_1"));
          return new Response(content, { headers: { "content-type": "application/json" } });
        }
        return new Response(JSON.stringify({ error: "not_found" }), { status: 404, headers: { "content-type": "application/json" } });
      },
    });
    stops.push(() => engine.stop(true));
    config.workspaces[0].baseUrl = `http://127.0.0.1:${engine.port}`;

    const server = await startServer(config);
    stops.push(() => server.stop());
    const base = `http://127.0.0.1:${server.port}`;
    const provider = { id: "anthropic", name: "Anthropic", env: ["ANTHROPIC_API_KEY"] };

    const clientAttempt = await fetch(`${base}/runtime-config/providers`, {
      method: "PATCH",
      headers: clientHeaders(),
      body: JSON.stringify({ provider: { lpr_anthropic: provider } }),
    });
    expect(clientAttempt.status).toBe(401);

    const hostAttempt = await fetch(`${base}/runtime-config/providers`, {
      method: "PATCH",
      headers: hostHeaders(),
      body: JSON.stringify({ provider: { lpr_anthropic: provider } }),
    });
    expect(hostAttempt.status).toBe(200);
    expect(await readJsonObject(hostAttempt)).toMatchObject({ ok: true, changed: true, reload: "reloaded" });
    expect(engineRequests.filter((request) => request === "POST /instance/dispose")).toHaveLength(1);

    const identicalAttempt = await fetch(`${base}/runtime-config/providers`, {
      method: "PATCH",
      headers: hostHeaders(),
      body: JSON.stringify({ provider: { lpr_anthropic: provider } }),
    });
    expect(identicalAttempt.status).toBe(200);
    expect(await readJsonObject(identicalAttempt)).toMatchObject({ ok: true, changed: false, reload: "skipped" });
    expect(engineRequests.filter((request) => request === "POST /instance/dispose")).toHaveLength(1);

    const removalAttempt = await fetch(`${base}/runtime-config/providers`, {
      method: "PATCH",
      headers: hostHeaders(),
      body: JSON.stringify({ provider: { lpr_anthropic: null } }),
    });
    expect(removalAttempt.status).toBe(200);
    expect(await readJsonObject(removalAttempt)).toMatchObject({ ok: true, changed: true, reload: "reloaded" });
    expect(engineRequests.filter((request) => request === "POST /instance/dispose")).toHaveLength(2);

    const globalRuntime = await readGlobalRuntimeWorkspaceEngineConfig(config);
    expect(runtimeProviderMap(globalRuntime)).toEqual({});
  });
});
