// Integration test for enabling/disabling the free-tier provider.
//
// Regression these pin: the engine's picker reads `providers.json`, NOT the
// runtime `provider` map. An earlier version wrote an opencode-style
// `{ options: { baseURL } }` entry there, which the engine ignored — the
// provider existed in config and never appeared in the model selector. So this
// asserts the on-disk engine catalog: base_url pointed at this server's
// loopback gateway, `wire_api` in the engine's spelling, a non-empty model
// list, and a resolvable `env_key`. Removal must clear both the record and the
// placeholder credential.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startServer } from "./server.js";

const CLIENT_TOKEN = "owt_free_tier_client";
const HOST_TOKEN = "owt_free_tier_host";
const roots: string[] = [];
const stops: Array<() => void | Promise<void>> = [];
const savedEnv = new Map<string, string | undefined>();

function rememberEnv(name: string): void {
  if (!savedEnv.has(name)) savedEnv.set(name, process.env[name]);
}

function clientHeaders(): Record<string, string> {
  return { authorization: `Bearer ${CLIENT_TOKEN}`, "content-type": "application/json" };
}

async function readJsonObject(response: Response): Promise<Record<string, unknown>> {
  const payload: unknown = await response.json();
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("Expected JSON object");
  }
  return payload as Record<string, unknown>;
}

type ProviderRecord = {
  api_key?: string;
  base_url?: string;
  wire_api?: string;
  name?: string;
  models?: unknown[];
};

async function readProviders(home: string): Promise<Record<string, ProviderRecord>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(home, "providers.json"), "utf8"));
    if (typeof parsed !== "object" || parsed === null) return {};
    const providers = (parsed as { providers?: unknown }).providers;
    return typeof providers === "object" && providers !== null
      ? (providers as Record<string, ProviderRecord>)
      : {};
  } catch {
    return {};
  }
}

async function readAuthStore(home: string): Promise<Record<string, string>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(home, "sofia-auth.json"), "utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function serverConfig(root: string): Record<string, unknown> {
  return {
    host: "127.0.0.1",
    port: 0,
    configPath: join(root, "server.json"),
    token: CLIENT_TOKEN,
    hostToken: HOST_TOKEN,
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

async function workspace(prefix: string): Promise<{ root: string; providerHome: string }> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  const providerHome = join(root, "provider-home");
  rememberEnv("SOFIA_RUNTIME_DB");
  rememberEnv("SOFIA_FREE_TIER_ENABLED");
  rememberEnv("SOFIA_PROVIDER_HOME");
  process.env.SOFIA_RUNTIME_DB = join(root, "runtime.sqlite");
  process.env.SOFIA_PROVIDER_HOME = providerHome;
  process.env.SOFIA_FREE_TIER_ENABLED = "0";
  return { root, providerHome };
}

afterEach(async () => {
  while (stops.length) await stops.pop()?.();
  while (roots.length) {
    const root = roots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  savedEnv.clear();
});

describe("free-tier provider registration", () => {
  test("writes the engine catalog entry the picker reads, then removes it", async () => {
    const { root, providerHome } = await workspace("sofia-free-tier-");
    const server = await startServer(serverConfig(root) as never);
    stops.push(() => server.stop());
    const base = `http://127.0.0.1:${server.port}`;

    const before = await fetch(`${base}/free-tier/status`, { headers: clientHeaders() });
    expect(await readJsonObject(before)).toMatchObject({ providerEnabled: false });

    const enable = await fetch(`${base}/free-tier/enabled`, {
      method: "POST",
      headers: clientHeaders(),
      body: JSON.stringify({ enabled: true }),
    });
    expect(enable.status).toBe(200);
    expect(await readJsonObject(enable)).toMatchObject({ ok: true, enabled: true, changed: true });

    const providers = await readProviders(providerHome);
    const record = providers["sofia-free"];
    expect(record).toBeDefined();
    expect(record?.base_url).toBe(`http://127.0.0.1:${server.port}/free-tier/v1`);
    // The engine spells this without the underscore (serde lowercase); the
    // reader normalizes either spelling, so match the on-disk convention.
    expect(record?.wire_api).toBe("chatcompletions");
    expect(record?.name).toBe("Sofia Free");
    expect(record?.models?.length).toBeGreaterThan(0);
    expect(await readAuthStore(providerHome)).toMatchObject({ SOFIA_FREE_API_KEY: "sofia-free" });

    // Idempotent: an unchanged record must not be rewritten or re-announced.
    const repeat = await fetch(`${base}/free-tier/enabled`, {
      method: "POST",
      headers: clientHeaders(),
      body: JSON.stringify({ enabled: true }),
    });
    expect(await readJsonObject(repeat)).toMatchObject({ changed: false });

    const afterEnable = await fetch(`${base}/free-tier/status`, { headers: clientHeaders() });
    expect(await readJsonObject(afterEnable)).toMatchObject({ providerEnabled: true });

    const disable = await fetch(`${base}/free-tier/enabled`, {
      method: "POST",
      headers: clientHeaders(),
      body: JSON.stringify({ enabled: false }),
    });
    expect(await readJsonObject(disable)).toMatchObject({ enabled: false, changed: true });
    expect(await readProviders(providerHome)).toEqual({});
    expect(await readAuthStore(providerHome)).toEqual({});
  });

  test("rejects a non-boolean toggle payload", async () => {
    const { root } = await workspace("sofia-free-tier-payload-");
    const server = await startServer(serverConfig(root) as never);
    stops.push(() => server.stop());

    const response = await fetch(`http://127.0.0.1:${server.port}/free-tier/enabled`, {
      method: "POST",
      headers: clientHeaders(),
      body: JSON.stringify({ enabled: "yes" }),
    });

    expect(response.status).toBe(400);
  });

  test("startup does not enroll a machine that never opted in", async () => {
    const { root, providerHome } = await workspace("sofia-free-tier-boot-off-");
    delete process.env.SOFIA_FREE_TIER_ENABLED;

    const server = await startServer(serverConfig(root) as never);
    stops.push(() => server.stop());
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(await readProviders(providerHome)).toEqual({});
  });

  test("startup rewrites an existing registration with the bound port", async () => {
    const { root, providerHome } = await workspace("sofia-free-tier-boot-refresh-");
    delete process.env.SOFIA_FREE_TIER_ENABLED;
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(providerHome, { recursive: true });
    await writeFile(
      join(providerHome, "providers.json"),
      JSON.stringify({
        providers: {
          "sofia-free": {
            api_key: "sofia-free",
            base_url: "http://127.0.0.1:1/free-tier/v1",
            wire_api: "chatcompletions",
            name: "Sofia Free",
            models: [{ id: "big-pickle", name: "Big Pickle", reasoning: true }],
          },
        },
      }),
    );

    const server = await startServer(serverConfig(root) as never);
    stops.push(() => server.stop());

    let baseUrl: string | undefined;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      baseUrl = (await readProviders(providerHome))["sofia-free"]?.base_url;
      if (baseUrl?.includes(`:${server.port}/`)) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    expect(baseUrl).toBe(`http://127.0.0.1:${server.port}/free-tier/v1`);
  });

  test("the gateway refuses requests that did not originate on this machine", async () => {
    const { root } = await workspace("sofia-free-tier-loopback-");
    const server = await startServer(serverConfig(root) as never);
    stops.push(() => server.stop());

    const response = await fetch(`http://127.0.0.1:${server.port}/free-tier/v1/models`, {
      headers: { host: "sofia.example", "x-forwarded-for": "203.0.113.7" },
    });

    expect(response.status).toBe(403);
  });
});
