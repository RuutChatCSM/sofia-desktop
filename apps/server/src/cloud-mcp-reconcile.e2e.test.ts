import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readRuntimeOpencodeConfig, writeRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import { startServer } from "./server.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";

type CloudConfig = {
  type: "remote";
  url: string;
  enabled: true;
  headers: { Authorization: string };
  oauth: false;
};

const CLIENT_TOKEN = "owt_cloud_mcp_client";
const HOST_TOKEN = "owt_cloud_mcp_host";
const previousRuntimeDb = process.env.SOFIA_RUNTIME_DB;
const stops: Array<() => void | Promise<void>> = [];
const roots: string[] = [];
const runtimeDbRoots: string[] = [];

afterEach(async () => {
  while (stops.length) await stops.pop()?.();
  while (roots.length) await rm(roots.pop() ?? "", { recursive: true, force: true });
  while (runtimeDbRoots.length) await rm(runtimeDbRoots.pop() ?? "", { recursive: true, force: true });
  if (previousRuntimeDb === undefined) delete process.env.SOFIA_RUNTIME_DB;
  else process.env.SOFIA_RUNTIME_DB = previousRuntimeDb;
});

async function createRoot(prefix = "sofia-cloud-mcp-"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function createRuntimeDbRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "sofia-cloud-mcp-runtime-"));
  runtimeDbRoots.push(root);
  return root;
}

function workspace(id: string, path: string, extra?: Partial<WorkspaceInfo>): WorkspaceInfo {
  return {
    id,
    name: id,
    path,
    preset: "starter",
    workspaceType: "local",
    ...extra,
  };
}

async function startSofia(workspaces: WorkspaceInfo[]): Promise<{ base: string; config: ServerConfig }> {
  const runtimeRoot = await createRuntimeDbRoot();
  process.env.SOFIA_RUNTIME_DB = join(runtimeRoot, "runtime.sqlite");
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    token: CLIENT_TOKEN,
    hostToken: HOST_TOKEN,
    configPath: join(runtimeRoot, "server.json"),
    approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: ["*"],
    workspaces,
    authorizedRoots: workspaces.map((item) => item.path),
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
  const server = await startServer(config);
  stops.push(() => server.stop());
  return { base: `http://127.0.0.1:${server.port}`, config };
}

function headers(): Record<string, string> {
  return { Authorization: `Bearer ${CLIENT_TOKEN}`, "Content-Type": "application/json" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (isRecord(value)) return value;
  throw new Error(`${label} was not an object`);
}

async function responseRecord(response: Response): Promise<Record<string, unknown>> {
  return requireRecord(await response.json(), "response");
}

function firstFailure(body: Record<string, unknown>): Record<string, unknown> {
  return requireRecord(body.firstFailure, "firstFailure");
}

const CLOUD_CONFIG: CloudConfig = {
  type: "remote",
  url: "https://sofia-api.ruut.chat/mcp/agent",
  enabled: true,
  headers: { Authorization: "Bearer owt_secret_cloud_token" },
  oauth: false,
};

async function reconcile(base: string, workspaceId = "ws_1", body: Record<string, unknown> = {}): Promise<Response> {
  const config = body.config ?? CLOUD_CONFIG;
  return fetch(`${base}/workspace/${workspaceId}/mcp/sofia-cloud/reconcile`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ config, ...body }),
  });
}

async function getHealth(base: string, workspaceId = "ws_1", query = ""): Promise<Response> {
  return fetch(`${base}/workspace/${workspaceId}/mcp/sofia-cloud/health${query}`, { headers: headers() });
}

async function engineRefresh(base: string, workspaceId = "ws_1", body?: Record<string, unknown>): Promise<Response> {
  return fetch(`${base}/workspace/${workspaceId}/mcp/sofia-cloud/engine-refresh`, {
    method: "POST",
    headers: headers(),
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

/**
 * Desired-config validation and request parsing run before any engine
 * interaction, so these stay engine-independent: they never reach the Codex
 * adapter or a live engine.
 */
describe("sofia-cloud MCP desired config", () => {
  test("rejects malformed desired config without persisting it", async () => {
    const root = await createRoot();
    const sofia = await startSofia([workspace("ws_1", root)]);

    const cases: Array<{ config: Record<string, unknown>; code: string }> = [
      { config: { ...CLOUD_CONFIG, url: "https://sofia-api.ruut.chat/mcp" }, code: "cloud_endpoint_invalid" },
      { config: { ...CLOUD_CONFIG, enabled: false }, code: "cloud_mcp_disabled" },
      { config: { ...CLOUD_CONFIG, headers: {} }, code: "invalid_mcp_token" },
      { config: { ...CLOUD_CONFIG, oauth: {} }, code: "invalid_mcp_token" },
    ];

    for (const item of cases) {
      const body = await responseRecord(await reconcile(sofia.base, "ws_1", { config: item.config }));
      expect(firstFailure(body).code).toBe(item.code);
      expect(firstFailure(body).stage).toBe("desired_config");
    }

    const mismatch = await responseRecord(await reconcile(sofia.base, "ws_1", {
      tokenMetadata: { organizationId: "org_token" },
      org: { id: "org_active" },
    }));
    expect(firstFailure(mismatch).code).toBe("cloud_token_org_mismatch");
    expect(firstFailure(mismatch).stage).toBe("desired_config");

    expect((await readRuntimeOpencodeConfig(sofia.config, "ws_1")).mcp?.["sofia-cloud"]).toBeUndefined();
  });

  test("GET health reports persisted malformed desired config even when an engine is configured", async () => {
    const root = await createRoot();
    const sofia = await startSofia([workspace("ws_1", root, { baseUrl: "http://127.0.0.1:1" })]);
    await writeRuntimeOpencodeConfig(sofia.config, "ws_1", (current) => ({
      ...current,
      mcp: { "sofia-cloud": { ...CLOUD_CONFIG, url: "https://sofia-api.ruut.chat/mcp" } },
    }));

    const body = await responseRecord(await getHealth(sofia.base));
    expect(body.usable).toBe(false);
    expect(firstFailure(body).code).toBe("cloud_endpoint_invalid");
    expect(firstFailure(body).stage).toBe("desired_config");
  });

  test("engine refresh reports desired_missing without touching the engine when no config is persisted", async () => {
    const root = await createRoot();
    const sofia = await startSofia([workspace("ws_1", root)]);

    const response = await engineRefresh(sofia.base);
    expect(response.status).toBe(200);
    const body = await responseRecord(response);

    const refresh = requireRecord(body.refresh, "refresh");
    expect(refresh.performed).toBe(false);
    expect(refresh.reason).toBe("desired_missing");
    expect(Array.isArray(refresh.steps)).toBe(true);
    expect(refresh.steps).toHaveLength(0);
    expect(requireRecord(body.health, "health").usable).toBe(false);
  });

  test("rejects malformed JSON on engine refresh instead of silently ignoring it", async () => {
    const root = await createRoot();
    const sofia = await startSofia([workspace("ws_1", root)]);

    const response = await fetch(`${sofia.base}/workspace/ws_1/mcp/sofia-cloud/engine-refresh`, {
      method: "POST",
      headers: headers(),
      body: "not-json",
    });
    expect(response.status).toBe(400);
    expect((await responseRecord(response)).code).toBe("invalid_json");
  });
});
