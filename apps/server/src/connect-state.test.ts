import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SOFIA_CLOUD_EXPECTED_TOOLS, SOFIA_CLOUD_PLUGIN_CANARIES } from "./cloud-mcp-health.js";
import { getConnectSnapshot } from "./connect-state.js";
import type {
  EngineMcpStatus,
  EngineProviderList,
  EngineResult,
  WorkspaceEngineClient,
} from "./engine/workspace-engine-client.js";
import { writeRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";

const previousRuntimeDb = process.env.SOFIA_RUNTIME_DB;
const runtimeDbRoots: string[] = [];
const roots: string[] = [];

afterEach(async () => {
  while (roots.length) await rm(roots.pop() ?? "", { recursive: true, force: true });
  while (runtimeDbRoots.length) await rm(runtimeDbRoots.pop() ?? "", { recursive: true, force: true });
  if (previousRuntimeDb === undefined) delete process.env.SOFIA_RUNTIME_DB;
  else process.env.SOFIA_RUNTIME_DB = previousRuntimeDb;
});

async function createRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function allReadyToolIds(): string[] {
  return [...SOFIA_CLOUD_EXPECTED_TOOLS, ...SOFIA_CLOUD_PLUGIN_CANARIES];
}

function ok<T>(data: T): EngineResult<T> {
  return { data, error: undefined, response: new Response(null, { status: 200 }) };
}

function unavailable(): EngineResult<never> {
  return { data: undefined, error: { code: "not_implemented" }, response: new Response(null, { status: 501 }) };
}

/**
 * A Codex-backed engine stand-in that reports the Cloud MCP connected with the
 * full expected tool surface. The connect snapshot only reads engine state, so
 * the transport is irrelevant to the directory-scoping behavior under test.
 */
function readyEngineClient(): WorkspaceEngineClient {
  const mcpStatus: EngineMcpStatus = { "sofia-cloud": { status: "connected" } };
  const providerList: EngineProviderList = {
    all: [
      {
        id: "anthropic",
        name: "Anthropic",
        models: { "claude-sonnet-4": { id: "claude-sonnet-4", name: "Claude Sonnet", capabilities: { toolcall: true } } },
      },
    ],
    default: {},
    connected: ["anthropic"],
  };
  return {
    session: {
      async list() { return ok([]); },
      async create() { return unavailable(); },
      async get() { return unavailable(); },
      async messages() { return ok([]); },
      async todo() { return ok([]); },
      async status() { return ok({}); },
      async promptAsync() { return ok({}); },
      async abort() { return ok({}); },
      async delete() { return ok({}); },
    },
    provider: {
      async list() { return ok(providerList); },
    },
    config: {
      async get() { return unavailable(); },
    },
    mcp: {
      async status() { return ok(mcpStatus); },
      async disconnect() { return ok({}); },
      auth: {
        async remove() { return ok({}); },
      },
    },
    tool: {
      async ids() { return ok(allReadyToolIds()); },
      async list() { return ok(allReadyToolIds().map((id) => ({ id, description: id }))); },
    },
    app: {
      async agents() { return ok([]); },
    },
    global: {
      async health() { return ok({ healthy: true, version: "1.17.11" }); },
    },
  };
}

function workspace(id: string, path: string, baseUrl: string): WorkspaceInfo {
  return { id, name: id, path, preset: "starter", workspaceType: "local", baseUrl };
}

function serverConfig(workspaces: WorkspaceInfo[], runtimeRoot: string): ServerConfig {
  process.env.SOFIA_RUNTIME_DB = join(runtimeRoot, "runtime.sqlite");
  return {
    host: "127.0.0.1",
    port: 0,
    token: "owt_connect_state_client",
    hostToken: "owt_connect_state_host",
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
}

describe("connect state Cloud health scoping", () => {
  test("uses verified health for the exact requested directory without borrowing another workspace", async () => {
    const rootA = await createRoot("sofia-connect-state-a-");
    const rootB = await createRoot("sofia-connect-state-b-");
    const runtimeRoot = await createRoot("sofia-connect-state-runtime-");
    const baseUrl = "http://127.0.0.1:1";
    const config = serverConfig([
      workspace("ws_a", rootA, baseUrl),
      workspace("ws_b", rootB, baseUrl),
    ], runtimeRoot);

    await writeRuntimeOpencodeConfig(config, "ws_b", (current) => ({
      ...current,
      mcp: {
        ...current.mcp,
        "sofia-cloud": {
          type: "remote",
          url: `${baseUrl}/cloud-mcp/mcp/agent`,
          enabled: true,
          headers: { Authorization: "Bearer owt_connect_state_cloud_token" },
          oauth: false,
        },
      },
    }));

    const options = { createWorkspaceOpencodeClient: () => readyEngineClient() };

    const first = await getConnectSnapshot(config, { directory: rootA, ...options });
    expect(first.cloudMcpPresent).toBe(false);
    expect(first.workspace.id).toBe("ws_a");
    expect(first.cloudHealth?.desired.present).toBe(false);

    const second = await getConnectSnapshot(config, { directory: rootB, ...options });
    expect(second.cloudMcpPresent).toBe(true);
    expect(second.workspace.id).toBe("ws_b");
    expect(second.cloudHealth?.usable).toBe(true);

    const unknown = await getConnectSnapshot(config, { directory: join(rootA, "other"), ...options });
    expect(unknown.cloudMcpPresent).toBe(false);
    expect(unknown.cloudHealth).toBeNull();
    expect(unknown.workspace.resolution).toBe("unknown");
  });
});
