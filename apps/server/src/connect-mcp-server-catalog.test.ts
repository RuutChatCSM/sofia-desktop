import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CONNECT_MCP_APP_HOST_CAPABILITY,
  CONNECT_MCP_APP_HOST_CAPABILITY_HEADER,
  CONNECT_MCP_SERVER_INDEX_URI,
  connectMcpAppHostName,
  type SofiaConnectMcpServerIndex,
  readSofiaConnectMcpAppHostCatalog,
  readSofiaConnectMcpServerIndex,
  reconcileSofiaConnectMcpServers,
  refreshSofiaConnectMcpAppHostCatalog,
  writeSofiaConnectMcpAppHostAuthorization,
  writeSofiaConnectMcpAppHostCatalog,
} from "./connect-mcp-server-catalog.js";
import { readRuntimeWorkspaceEngineConfig, writeRuntimeWorkspaceEngineConfig } from "./runtime-engine-config-store.js";
import type { ServerConfig } from "./types.js";

const roots: string[] = [];
const previousRuntimeDb = process.env.SOFIA_RUNTIME_DB;

afterEach(async () => {
  while (roots.length) await rm(roots.pop() ?? "", { recursive: true, force: true });
  if (previousRuntimeDb === undefined) delete process.env.SOFIA_RUNTIME_DB;
  else process.env.SOFIA_RUNTIME_DB = previousRuntimeDb;
});

async function fixtureConfig(): Promise<ServerConfig> {
  const root = await mkdtemp(join(tmpdir(), "sofia-connect-mcp-servers-"));
  roots.push(root);
  process.env.SOFIA_RUNTIME_DB = join(root, "runtime.sqlite");
  return {
    host: "127.0.0.1",
    port: 0,
    token: "test",
    hostToken: "host",
    configPath: join(root, "sofia.json"),
    approval: { mode: "auto", timeoutMs: 1_000 },
    corsOrigins: ["*"],
    workspaces: [{ id: "ws_1", name: "One", path: root, preset: "starter", workspaceType: "local" }],
    authorizedRoots: [root],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
}

function indexFetcher(
  requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }>,
  servers: SofiaConnectMcpServerIndex["servers"] = [{
    connectionId: "emc_01k28e8q8pf8r9sff9mhyqxved",
    name: "Project Atlas",
    description: null,
    url: "https://sofia-api.ruut.chat/mcp/agent/connections/emc_01k28e8q8pf8r9sff9mhyqxved",
  }],
) {
  return async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push({ url, headers: new Headers(init?.headers), body });
    if (body.method === "initialize") {
      return Response.json({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", capabilities: { resources: {} } } });
    }
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    return Response.json({
      jsonrpc: "2.0",
      id: 2,
      result: {
        contents: [{
          uri: CONNECT_MCP_SERVER_INDEX_URI,
          mimeType: "application/json",
          text: JSON.stringify({
            schemaVersion: "sofia.connect/mcp-servers/1",
            servers,
          }),
        }],
      },
    });
  };
}

describe("Sofia Connect MCP server catalog", () => {
  test("reads the member catalog through an authenticated MCP resource", async () => {
    const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
    const index = await readSofiaConnectMcpServerIndex({
      type: "remote",
      url: "https://sofia-api.ruut.chat/mcp/agent",
      headers: { Authorization: "Bearer member-token" },
    }, "Bearer private-app-host-token", indexFetcher(requests));

    expect(index?.servers[0]?.name).toBe("Project Atlas");
    expect(requests.map((request) => request.body.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "resources/read",
    ]);
    expect(requests.every((request) => request.headers.get("authorization") === "Bearer private-app-host-token")).toBe(true);
    expect(requests.every((request) => request.headers.get(CONNECT_MCP_APP_HOST_CAPABILITY_HEADER)
      === CONNECT_MCP_APP_HOST_CAPABILITY)).toBe(true);
  });

  test("keeps hosted api-origin provider proxies on the credential-bound app gateway origin", async () => {
    const index = await readSofiaConnectMcpServerIndex({
      type: "remote",
      url: "https://sofia-app.ruut.chat/api/den/mcp/agent",
    }, "Bearer private-app-host-token", indexFetcher([]));

    expect(index?.servers[0]?.url).toBe(
      "https://sofia-app.ruut.chat/api/den/mcp/agent/connections/emc_01k28e8q8pf8r9sff9mhyqxved",
    );
  });

  test("reconciles only Sofia-owned proxy entries and preserves user MCPs", async () => {
    const config = await fixtureConfig();
    await writeRuntimeWorkspaceEngineConfig(config, "ws_1", () => ({
      mcp: {
        "sofia-cloud": { type: "remote", url: "https://sofia-api.ruut.chat/mcp/agent" },
        "user-server": { type: "remote", url: "https://user.example/mcp" },
        "sofia-connect-stale": { type: "remote", url: "https://cloud.example/stale" },
      },
    }));
    const connectionId = "emc_01k28e8q8pf8r9sff9mhyqxved";
    const result = await reconcileSofiaConnectMcpServers({
      config,
      workspace: config.workspaces[0]!,
      cloudMcp: {
        type: "remote",
        url: "https://sofia-api.ruut.chat/mcp/agent",
        headers: { Authorization: "Bearer member-token" },
      },
      appHostAuthorization: "Bearer private-app-host-token",
      fetcher: indexFetcher([]),
    });

    const runtime = await readRuntimeWorkspaceEngineConfig(config, "ws_1");
    expect(result).toEqual({
      status: "synced",
      appHostNames: [connectMcpAppHostName(connectionId)],
      removedNames: ["sofia-connect-stale"],
    });
    expect(runtime.mcp?.["sofia-cloud"]).toEqual({ type: "remote", url: "https://sofia-api.ruut.chat/mcp/agent" });
    expect(runtime.mcp?.["user-server"]).toEqual({ type: "remote", url: "https://user.example/mcp" });
    expect(runtime.mcp?.["sofia-connect-stale"]).toBeUndefined();
    expect(Object.keys(runtime.mcp ?? {}).some((name) => name.startsWith("sofia-connect-"))).toBe(false);
    expect(await readSofiaConnectMcpAppHostCatalog(config, "ws_1")).toEqual({
      schemaVersion: "sofia.connect/mcp-servers/1",
      servers: [{
        connectionId,
        name: "Project Atlas",
        description: null,
        url: `https://sofia-api.ruut.chat/mcp/agent/connections/${connectionId}`,
      }],
    });
  });

  test("opportunistically refreshes a stale private catalog from the runtime Cloud endpoint", async () => {
    const config = await fixtureConfig();
    const connectionId = "emc_01k28e8q8pf8r9sff9mhyqxved";
    const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
    await writeRuntimeWorkspaceEngineConfig(config, "ws_1", () => ({
      mcp: {
        "sofia-cloud": { type: "remote", url: "https://sofia-api.ruut.chat/mcp/agent" },
      },
    }));
    await writeSofiaConnectMcpAppHostAuthorization(
      config,
      "ws_1",
      "Bearer private-app-host-token",
      "https://sofia-api.ruut.chat/mcp/agent",
    );

    const result = await refreshSofiaConnectMcpAppHostCatalog(config, "ws_1", indexFetcher(requests));

    expect(result).toEqual({ status: "synced", appHostNames: [connectMcpAppHostName(connectionId)] });
    expect((await readSofiaConnectMcpAppHostCatalog(config, "ws_1")).servers[0]?.connectionId).toBe(connectionId);
    expect(requests.every((request) => request.headers.get("authorization") === "Bearer private-app-host-token")).toBe(true);
  });

  test("preserves the last known-good catalog when an opportunistic refresh is unavailable", async () => {
    const config = await fixtureConfig();
    const connectionId = "emc_01lastknowngood";
    await writeRuntimeWorkspaceEngineConfig(config, "ws_1", () => ({
      mcp: {
        "sofia-cloud": { type: "remote", url: "https://sofia-api.ruut.chat/mcp/agent" },
      },
    }));
    await writeSofiaConnectMcpAppHostAuthorization(
      config,
      "ws_1",
      "Bearer private-app-host-token",
      "https://sofia-api.ruut.chat/mcp/agent",
    );
    await writeSofiaConnectMcpAppHostCatalog(config, "ws_1", {
      schemaVersion: "sofia.connect/mcp-servers/1",
      servers: [{
        connectionId,
        name: "Last known good",
        description: null,
        url: `https://sofia-api.ruut.chat/mcp/agent/connections/${connectionId}`,
      }],
    });

    const result = await refreshSofiaConnectMcpAppHostCatalog(
      config,
      "ws_1",
      async () => new Response(null, { status: 503 }),
    );

    expect(result).toEqual({ status: "unavailable", appHostNames: [] });
    expect((await readSofiaConnectMcpAppHostCatalog(config, "ws_1")).servers[0]?.connectionId).toBe(connectionId);
  });

  test("fails closed and purges prior runtime entries when Cloud has no index", async () => {
    const config = await fixtureConfig();
    await writeRuntimeWorkspaceEngineConfig(config, "ws_1", () => ({
      mcp: { "sofia-connect-existing": { type: "remote", url: "https://cloud.example/existing" } },
    }));
    const result = await reconcileSofiaConnectMcpServers({
      config,
      workspace: config.workspaces[0]!,
      cloudMcp: { type: "remote", url: "https://sofia-api.ruut.chat/mcp/agent" },
      fetcher: async () => new Response(null, { status: 404 }),
    });
    expect(result).toEqual({
      status: "unavailable",
      appHostNames: [],
      removedNames: ["sofia-connect-existing"],
    });
    expect((await readRuntimeWorkspaceEngineConfig(config, "ws_1")).mcp?.["sofia-connect-existing"]).toBeUndefined();
    expect((await readSofiaConnectMcpAppHostCatalog(config, "ws_1")).servers).toEqual([]);
  });

  test("an empty index removes prior Sofia-owned provider servers", async () => {
    const config = await fixtureConfig();
    await writeRuntimeWorkspaceEngineConfig(config, "ws_1", () => ({
      mcp: {
        "user-server": { type: "remote", url: "https://user.example/mcp" },
        "sofia-connect-existing": { type: "remote", url: "https://cloud.example/existing" },
      },
    }));
    const result = await reconcileSofiaConnectMcpServers({
      config,
      workspace: config.workspaces[0]!,
      cloudMcp: { type: "remote", url: "https://sofia-api.ruut.chat/mcp/agent" },
      appHostAuthorization: "Bearer private-app-host-token",
      fetcher: indexFetcher([], []),
    });

    expect(result).toEqual({
      status: "synced",
      appHostNames: [],
      removedNames: ["sofia-connect-existing"],
    });
    const runtime = await readRuntimeWorkspaceEngineConfig(config, "ws_1");
    expect(runtime.mcp?.["sofia-connect-existing"]).toBeUndefined();
    expect(runtime.mcp?.["user-server"]).toEqual({ type: "remote", url: "https://user.example/mcp" });
  });

  test("never sends the persisted App-host credential to an untrusted reconcile endpoint", async () => {
    const config = await fixtureConfig();
    const trustedRequests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
    await reconcileSofiaConnectMcpServers({
      config,
      workspace: config.workspaces[0]!,
      cloudMcp: { type: "remote", url: "https://sofia-api.ruut.chat/mcp/agent" },
      appHostAuthorization: "Bearer private-app-host-token",
      fetcher: indexFetcher(trustedRequests),
    });
    expect(trustedRequests.length).toBeGreaterThan(0);

    let untrustedRequests = 0;
    const result = await reconcileSofiaConnectMcpServers({
      config,
      workspace: config.workspaces[0]!,
      cloudMcp: { type: "remote", url: "https://attacker.example/mcp/agent" },
      fetcher: async () => {
        untrustedRequests += 1;
        return new Response(null, { status: 500 });
      },
    });

    expect(untrustedRequests).toBe(0);
    expect(result.status).toBe("unavailable");
    expect((await readSofiaConnectMcpAppHostCatalog(config, "ws_1")).servers).toEqual([]);
  });

  test("rejects a catalog that points the private App-host credential at another origin", async () => {
    const config = await fixtureConfig();
    const result = await reconcileSofiaConnectMcpServers({
      config,
      workspace: config.workspaces[0]!,
      cloudMcp: { type: "remote", url: "https://sofia-api.ruut.chat/mcp/agent" },
      appHostAuthorization: "Bearer private-app-host-token",
      fetcher: indexFetcher([], [{
        connectionId: "emc_01crossorigin",
        name: "Untrusted endpoint",
        description: null,
        url: "https://attacker.example/mcp/agent/connections/emc_01crossorigin",
      }]),
    });

    expect(result).toEqual({ status: "unavailable", appHostNames: [], removedNames: [] });
    expect((await readSofiaConnectMcpAppHostCatalog(config, "ws_1")).servers).toEqual([]);
  });

  test("rejects a hosted api-origin descriptor that is not the exact connection proxy", async () => {
    const config = await fixtureConfig();
    const result = await reconcileSofiaConnectMcpServers({
      config,
      workspace: config.workspaces[0]!,
      cloudMcp: { type: "remote", url: "https://sofia-app.ruut.chat/api/den/mcp/agent" },
      appHostAuthorization: "Bearer private-app-host-token",
      fetcher: indexFetcher([], [{
        connectionId: "emc_01crossorigin",
        name: "Wrong proxy path",
        description: null,
        url: "https://sofia-api.ruut.chat/mcp/agent/connections/another-connection",
      }]),
    });

    expect(result).toEqual({ status: "unavailable", appHostNames: [], removedNames: [] });
    expect((await readSofiaConnectMcpAppHostCatalog(config, "ws_1")).servers).toEqual([]);
  });
});
