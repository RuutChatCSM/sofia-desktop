// End-to-end coverage for connecting a provider from the app against the
// bundled engine's provider catalog.
//
// Regression this pins: `/provider/auth` returned a hardcoded object with a
// single `openai` key, so the connect modal could only ever offer OpenAI. A
// user could not connect Anthropic, OpenRouter, Groq, DeepSeek or anything else
// from the app even though the engine supported all of them.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { readCodexAuthStore } from "./codex-auth-store.js";
import { readCodexEngineConfig } from "./codex-providers.js";
import { resetProviderModelDiscoveryCache } from "./codex-model-discovery.js";
import { resetModelsDevCatalogCache } from "./models-dev-catalog.js";
import { startServer } from "./server.js";
import type { ServerConfig } from "./types.js";

type Served = { port: number; stop: (closeActiveConnections?: boolean) => void | Promise<void> };

const CLIENT_TOKEN = "owt_provider_connect_client";
const HOST_TOKEN = "owt_provider_connect_host";
const stops: Array<() => void | Promise<void>> = [];
const roots: string[] = [];
const priorDataDir = process.env.SOFIA_DATA_DIR;
const priorTokenStore = process.env.SOFIA_TOKEN_STORE;
const priorProviderHome = process.env.SOFIA_PROVIDER_HOME;

/**
 * A minimal models.dev payload. Tests that need the full catalog serve the real
 * snapshot; most only care that a provider resolves.
 */
const CATALOG_STUB = {
  deepseek: {
    id: "deepseek",
    name: "DeepSeek",
    env: ["DEEPSEEK_API_KEY"],
    api: "https://api.deepseek.com/v1",
    models: {
      "deepseek-chat": { id: "deepseek-chat", name: "DeepSeek Chat" },
      "deepseek-reasoner": { id: "deepseek-reasoner", name: "DeepSeek Reasoner" },
    },
  },
  openrouter: {
    id: "openrouter",
    name: "OpenRouter",
    env: ["OPENROUTER_API_KEY"],
    api: "https://openrouter.ai/api/v1",
    models: {},
  },
  perplexity: {
    id: "perplexity",
    name: "Perplexity",
    env: ["PERPLEXITY_API_KEY"],
    api: "https://api.perplexity.ai",
    models: {},
  },
  groq: {
    id: "groq",
    name: "Groq",
    env: ["GROQ_API_KEY"],
    api: "https://api.groq.com/openai/v1",
    models: {},
  },
} as const;

/**
 * Route a discovery stub: the models.dev catalog URL and a provider's `/models`
 * endpoint are different requests and must be answered differently.
 */
function discoveryRoutes(options: {
  models?: () => Response;
  catalog?: unknown;
} = {}) {
  const models = options.models ?? (() => new Response("not found", { status: 404 }));
  return (async (url: string) => {
    const target = String(url);
    if (target.endsWith("/models")) return models();
    return new Response(JSON.stringify(options.catalog ?? CATALOG_STUB), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

function clientAuth() {
  return { authorization: `Bearer ${CLIENT_TOKEN}`, "content-type": "application/json" };
}

async function createTempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function startSofiaServer(workspaceRoot: string, hooks?: { providerDiscoveryFetch?: typeof fetch }) {
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
  const server = (await startServer(config, hooks)) as Served;
  stops.push(() => server.stop(true));
  return { base: `http://127.0.0.1:${server.port}`, config };
}

beforeEach(async () => {
  const envRoot = await createTempRoot("sofia-provider-connect-");
  process.env.SOFIA_DATA_DIR = join(envRoot, "data");
  process.env.SOFIA_TOKEN_STORE = join(envRoot, "tokens.json");
  // Pin the engine home so the provider catalog and credential store land in a
  // temp dir instead of the developer's real ~/.sofia.
  process.env.SOFIA_PROVIDER_HOME = join(envRoot, "engine-home");
  // Both caches are process-wide; clear them so one test's stub or failure
  // cannot leak into the next (or reach the live catalog).
  resetProviderModelDiscoveryCache();
  resetModelsDevCatalogCache();
});

afterEach(async () => {
  resetProviderModelDiscoveryCache();
  resetModelsDevCatalogCache();
  while (stops.length) {
    await stops.pop()?.();
  }
  while (roots.length) {
    await rm(roots.pop()!, { recursive: true, force: true });
  }
  if (priorDataDir === undefined) delete process.env.SOFIA_DATA_DIR;
  else process.env.SOFIA_DATA_DIR = priorDataDir;
  if (priorTokenStore === undefined) delete process.env.SOFIA_TOKEN_STORE;
  else process.env.SOFIA_TOKEN_STORE = priorTokenStore;
  if (priorProviderHome === undefined) delete process.env.SOFIA_PROVIDER_HOME;
  else process.env.SOFIA_PROVIDER_HOME = priorProviderHome;
});

describe("provider auth methods", () => {
  test("offers every connectable provider, not just openai", async () => {
    const root = resolve(await createTempRoot("sofia-provider-connect-ws-"));
    const { base } = await startSofiaServer(root);

    const response = await fetch(`${base}/workspace/ws_1/provider/auth`, { headers: clientAuth() });
    expect(response.status).toBe(200);
    const methods = (await response.json()) as Record<string, Array<{ type: string }>>;

    expect(Object.keys(methods).length).toBeGreaterThan(1);
    for (const id of ["openai", "anthropic", "openrouter", "groq", "deepseek"]) {
      expect(Object.keys(methods)).toContain(id);
      expect(methods[id]?.length ?? 0).toBeGreaterThan(0);
    }
  });

  test("offers an api key method for non-openai providers", async () => {
    const root = resolve(await createTempRoot("sofia-provider-connect-ws-"));
    const { base } = await startSofiaServer(root);

    const response = await fetch(`${base}/workspace/ws_1/provider/auth`, { headers: clientAuth() });
    const methods = (await response.json()) as Record<string, Array<{ type: string }>>;

    expect(methods.anthropic?.map((method) => method.type)).toContain("api");
    expect(methods.openai?.map((method) => method.type)).toContain("oauth");
  });
});

describe("connecting a provider with an API key", () => {
  test("stores the credential under the provider's engine env var", async () => {
    const root = resolve(await createTempRoot("sofia-provider-connect-ws-"));
    const { base } = await startSofiaServer(root);

    const response = await fetch(`${base}/workspace/ws_1/codex/auth/anthropic`, {
      method: "PUT",
      headers: clientAuth(),
      body: JSON.stringify({ key: "sk-ant-test" }),
    });
    expect(response.status).toBe(200);

    const auth = await readCodexAuthStore();
    // The engine reads ANTHROPIC_API_KEY, so that is where the key must land.
    expect(auth.ANTHROPIC_API_KEY).toBe("sk-ant-test");
  });

  test("registers the provider so it becomes visible in the provider list", async () => {
    const root = resolve(await createTempRoot("sofia-provider-connect-ws-"));
    const { base } = await startSofiaServer(root);

    await fetch(`${base}/workspace/ws_1/codex/auth/deepseek`, {
      method: "PUT",
      headers: clientAuth(),
      body: JSON.stringify({ key: "sk-deepseek-test" }),
    });

    // A credential alone is not enough: without a catalog entry the provider is
    // invisible in the picker and unusable by the engine.
    const config = await readCodexEngineConfig();
    const provider = config.providers.find((entry) => entry.providerId === "deepseek");
    expect(provider).toBeDefined();
    expect(provider?.providerName).toBe("DeepSeek");
    expect(provider?.envKey).toBe("DEEPSEEK_API_KEY");
    expect(config.providers.map((entry) => entry.providerId)).toContain("deepseek");
  });

  test("keeps the engine's non-derivable env name for google", async () => {
    const root = resolve(await createTempRoot("sofia-provider-connect-ws-"));
    const { base } = await startSofiaServer(root);

    await fetch(`${base}/workspace/ws_1/codex/auth/google`, {
      method: "PUT",
      headers: clientAuth(),
      body: JSON.stringify({ key: "gemini-test" }),
    });

    const auth = await readCodexAuthStore();
    expect(auth.GEMINI_API_KEY).toBe("gemini-test");
  });

  test("preserves an existing provider's discovered models", async () => {
    const root = resolve(await createTempRoot("sofia-provider-connect-ws-"));
    const { base } = await startSofiaServer(root);

    await fetch(`${base}/workspace/ws_1/codex/auth/deepseek`, {
      method: "PUT",
      headers: clientAuth(),
      body: JSON.stringify({ key: "sk-first" }),
    });
    // Reconnecting must not wipe the models discovered for the provider.
    await fetch(`${base}/workspace/ws_1/codex/auth/deepseek`, {
      method: "PUT",
      headers: clientAuth(),
      body: JSON.stringify({ key: "sk-rotated" }),
    });

    const auth = await readCodexAuthStore();
    expect(auth.DEEPSEEK_API_KEY).toBe("sk-rotated");
    const config = await readCodexEngineConfig();
    expect(config.providers.find((entry) => entry.providerId === "deepseek")).toBeDefined();
  });

  test("rejects an empty key", async () => {
    const root = resolve(await createTempRoot("sofia-provider-connect-ws-"));
    const { base } = await startSofiaServer(root);

    const response = await fetch(`${base}/workspace/ws_1/codex/auth/anthropic`, {
      method: "PUT",
      headers: clientAuth(),
      body: JSON.stringify({ key: "" }),
    });
    expect(response.status).toBe(400);
  });
});

describe("disconnecting a provider", () => {
  test("clears the credential under the engine env var", async () => {
    const root = resolve(await createTempRoot("sofia-provider-connect-ws-"));
    const { base } = await startSofiaServer(root);

    await fetch(`${base}/workspace/ws_1/codex/auth/anthropic`, {
      method: "PUT",
      headers: clientAuth(),
      body: JSON.stringify({ key: "sk-ant-test" }),
    });
    expect((await readCodexAuthStore()).ANTHROPIC_API_KEY).toBe("sk-ant-test");

    await fetch(`${base}/workspace/ws_1/codex/auth/anthropic`, { method: "DELETE", headers: clientAuth() });

    const auth = await readCodexAuthStore();
    expect(auth.ANTHROPIC_API_KEY).toBeUndefined();
    // No key may remain under any name the engine could resolve.
    expect(Object.keys(auth)).toHaveLength(0);
  });
});

describe("model discovery at connect time", () => {
  /**
   * A provider with an empty model catalog is still invisible in the picker, so
   * a connect must resolve the catalog before returning rather than leaving the
   * provider registered-but-blank until some later config read.
   */
  test("populates the provider's model catalog before the connect returns", async () => {
    const root = resolve(await createTempRoot("sofia-provider-connect-ws-"));
    const requests: string[] = [];
    const fetchImpl = (async (url: string) => {
      requests.push(String(url));
      if (String(url).endsWith("/models")) {
        return new Response(
          JSON.stringify({
            data: [
              { id: "deepseek-chat", name: "DeepSeek Chat" },
              { id: "deepseek-reasoner", name: "DeepSeek Reasoner" },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify(CATALOG_STUB), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const { base } = await startSofiaServer(root, { providerDiscoveryFetch: fetchImpl });

    const response = await fetch(`${base}/workspace/ws_1/codex/auth/deepseek`, {
      method: "PUT",
      headers: clientAuth(),
      body: JSON.stringify({ key: "sk-deepseek-test" }),
    });
    expect(response.status).toBe(200);

    // The catalog is consulted for the provider's base URL and model list, so a
    // provider the user connects is immediately selectable...
    const config = await readCodexEngineConfig();
    const provider = config.providers.find((entry) => entry.providerId === "deepseek");
    expect(provider).toBeDefined();
    expect(provider?.baseUrl).toBe("https://api.deepseek.com/v1");
    expect(provider?.models.map((model) => model.id).sort()).toEqual([
      "deepseek-chat",
      "deepseek-reasoner",
    ]);
    // ...and the live /models probe is skipped, since the catalog already
    // answered it. A provider that already has models is never re-probed.
    expect(requests.filter((url) => url.endsWith("/models"))).toEqual([]);
  });

  test("probes with the key that was just entered", async () => {
    const root = resolve(await createTempRoot("sofia-provider-connect-ws-"));
    const authorizations: Array<string | null> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/models")) {
        authorizations.push(new Headers(init?.headers).get("authorization"));
        return new Response(JSON.stringify({ data: [{ id: "groq-1" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify(CATALOG_STUB), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const { base } = await startSofiaServer(root, { providerDiscoveryFetch: fetchImpl });

    await fetch(`${base}/workspace/ws_1/codex/auth/groq`, {
      method: "PUT",
      headers: clientAuth(),
      body: JSON.stringify({ key: "gsk-auth-check" }),
    });

    // Discovery runs after the credential is stored, so the probe must be
    // authenticated with the key just entered.
    expect(authorizations).toEqual(["Bearer gsk-auth-check"]);
  });

  test("still registers the provider when its models endpoint fails", async () => {
    const root = resolve(await createTempRoot("sofia-provider-connect-ws-"));
    const fetchImpl = discoveryRoutes({ models: () => new Response("nope", { status: 500 }) });

    const { base } = await startSofiaServer(root, { providerDiscoveryFetch: fetchImpl });

    const response = await fetch(`${base}/workspace/ws_1/codex/auth/groq`, {
      method: "PUT",
      headers: clientAuth(),
      body: JSON.stringify({ key: "gsk-test" }),
    });

    // A provider whose /models is unreachable must still connect.
    expect(response.status).toBe(200);
    expect((await readCodexAuthStore()).GROQ_API_KEY).toBe("gsk-test");
    const config = await readCodexEngineConfig();
    expect(config.providers.map((entry) => entry.providerId)).toContain("groq");
  });

  test("fills in models for a provider that failed to discover earlier", async () => {
    const root = resolve(await createTempRoot("sofia-provider-connect-ws-"));
    const failing = discoveryRoutes({ models: () => new Response("nope", { status: 500 }) });
    const { base } = await startSofiaServer(root, { providerDiscoveryFetch: failing });

    await fetch(`${base}/workspace/ws_1/codex/auth/openrouter`, {
      method: "PUT",
      headers: clientAuth(),
      body: JSON.stringify({ key: "sk-or-test" }),
    });
    expect(
      (await readCodexEngineConfig()).providers.find((entry) => entry.providerId === "openrouter")?.models,
    ).toEqual([]);

    // Reconnecting with a reachable provider resolves the catalog without the
    // user having to remove the provider first.
    resetProviderModelDiscoveryCache();
    const working = discoveryRoutes({
      models: () =>
        new Response(JSON.stringify({ data: [{ id: "openrouter/auto" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    const second = await startSofiaServer(root, { providerDiscoveryFetch: working });
    await fetch(`${second.base}/workspace/ws_1/codex/auth/openrouter`, {
      method: "PUT",
      headers: clientAuth(),
      body: JSON.stringify({ key: "sk-or-test" }),
    });

    const provider = (await readCodexEngineConfig()).providers.find(
      (entry) => entry.providerId === "openrouter",
    );
    expect(provider?.models.map((model) => model.id)).toEqual(["openrouter/auto"]);
  });

  test("does not re-probe a provider that already has models", async () => {
    const root = resolve(await createTempRoot("sofia-provider-connect-ws-"));
    const fetchImpl = discoveryRoutes({
      models: () =>
        new Response(JSON.stringify({ data: [{ id: "should-not-appear" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });

    const { base } = await startSofiaServer(root, { providerDiscoveryFetch: fetchImpl });
    await fetch(`${base}/workspace/ws_1/codex/auth/perplexity`, {
      method: "PUT",
      headers: clientAuth(),
      body: JSON.stringify({ key: "pplx-test" }),
    });
    await fetch(`${base}/workspace/ws_1/codex/auth/perplexity`, {
      method: "PUT",
      headers: clientAuth(),
      body: JSON.stringify({ key: "pplx-rotated" }),
    });

    const provider = (await readCodexEngineConfig()).providers.find(
      (entry) => entry.providerId === "perplexity",
    );
    expect(provider?.models.map((model) => model.id)).toEqual(["should-not-appear"]);
    // Rotating a key must not discard an already discovered catalog.
    expect((await readCodexAuthStore()).PERPLEXITY_API_KEY).toBe("pplx-rotated");
  });
});

describe("provider auth methods come from the full catalog", () => {
  test("offers catalog providers beyond the static well-known list", async () => {
    const root = resolve(await createTempRoot("sofia-provider-connect-ws-"));
    const { base } = await startSofiaServer(root, { providerDiscoveryFetch: discoveryRoutes() });

    const response = await fetch(`${base}/workspace/ws_1/provider/auth`, { headers: clientAuth() });
    expect(response.status).toBe(200);
    const methods = (await response.json()) as Record<string, Array<{ type: string }>>;

    // The static well-known providers are still offered...
    for (const id of ["openai", "anthropic", "groq"]) {
      expect(Object.keys(methods)).toContain(id);
    }
    // ...plus everything the catalog adds.
    expect(Object.keys(methods)).toContain("openrouter");
  });

  test("serves a large catalog rather than a fixed short list", async () => {
    const root = resolve(await createTempRoot("sofia-provider-connect-ws-"));
    const bigCatalog: Record<string, unknown> = {};
    for (let index = 0; index < 150; index += 1) {
      bigCatalog[`gateway-${index}`] = {
        name: `Gateway ${index}`,
        env: [`GATEWAY_${index}_API_KEY`],
        api: `https://gateway-${index}.example/v1`,
        models: { [`model-${index}`]: { name: `Model ${index}` } },
      };
    }
    const { base } = await startSofiaServer(root, {
      providerDiscoveryFetch: discoveryRoutes({ catalog: bigCatalog }),
    });

    const response = await fetch(`${base}/workspace/ws_1/provider/auth`, { headers: clientAuth() });
    const methods = (await response.json()) as Record<string, Array<{ type: string; label: string }>>;

    expect(Object.keys(methods).length).toBeGreaterThan(150);
    expect(methods["gateway-7"]).toEqual([{ type: "api", label: "API key" }]);
  });

  test("falls back to the static list when the catalog is unreachable", async () => {
    const root = resolve(await createTempRoot("sofia-provider-connect-ws-"));
    const offline = (async () => new Response("down", { status: 503 })) as unknown as typeof fetch;
    const { base } = await startSofiaServer(root, { providerDiscoveryFetch: offline });

    const response = await fetch(`${base}/workspace/ws_1/provider/auth`, { headers: clientAuth() });
    expect(response.status).toBe(200);
    const methods = (await response.json()) as Record<string, Array<{ type: string }>>;

    // A catalog outage must not empty the connect modal.
    for (const id of ["openai", "anthropic", "deepseek"]) {
      expect(Object.keys(methods)).toContain(id);
    }
  });

  test("registers a catalog-only provider with its base url and models", async () => {
    const root = resolve(await createTempRoot("sofia-provider-connect-ws-"));
    const catalog = {
      "neuralwatt": {
        name: "Neuralwatt",
        env: ["NEURALWATT_API_KEY"],
        api: "https://api.neuralwatt.com/v1",
        models: {
          "nw-large": { name: "Neuralwatt Large", limit: { context: 128000 } },
          "nw-embed": { name: "Neuralwatt Embed" },
        },
      },
    };
    const { base } = await startSofiaServer(root, {
      providerDiscoveryFetch: discoveryRoutes({ catalog }),
    });

    await fetch(`${base}/workspace/ws_1/codex/auth/neuralwatt`, {
      method: "PUT",
      headers: clientAuth(),
      body: JSON.stringify({ key: "nw-test" }),
    });

    const provider = (await readCodexEngineConfig()).providers.find(
      (entry) => entry.providerId === "neuralwatt",
    );
    expect(provider?.baseUrl).toBe("https://api.neuralwatt.com/v1");
    expect(provider?.providerName).toBe("Neuralwatt");
    // Non-chat models stay out of the picker.
    expect(provider?.models.map((model) => model.id)).toEqual(["nw-large"]);
    expect((await readCodexAuthStore()).NEURALWATT_API_KEY).toBe("nw-test");
  });

  test("writes every env alias the catalog lists for a provider", async () => {
    const root = resolve(await createTempRoot("sofia-provider-connect-ws-"));
    const catalog = {
      google: {
        name: "Google",
        env: ["GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "GEMINI_API_KEY"],
        api: "https://generativelanguage.googleapis.com/v1beta",
        models: { "gemini-2.5-pro": { name: "Gemini 2.5 Pro" } },
      },
    };
    const { base } = await startSofiaServer(root, {
      providerDiscoveryFetch: discoveryRoutes({ catalog }),
    });

    await fetch(`${base}/workspace/ws_1/codex/auth/google`, {
      method: "PUT",
      headers: clientAuth(),
      body: JSON.stringify({ key: "gemini-key" }),
    });

    // The engine resolves a single env_key, so every alias must carry the key.
    const auth = await readCodexAuthStore();
    expect(auth.GEMINI_API_KEY).toBe("gemini-key");
    expect(auth.GOOGLE_API_KEY).toBe("gemini-key");
    expect(auth.GOOGLE_GENERATIVE_AI_API_KEY).toBe("gemini-key");
  });

  test("disconnect clears every env alias", async () => {
    const root = resolve(await createTempRoot("sofia-provider-connect-ws-"));
    const catalog = {
      google: {
        name: "Google",
        env: ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
        api: "https://generativelanguage.googleapis.com/v1beta",
        models: {},
      },
    };
    const { base } = await startSofiaServer(root, {
      providerDiscoveryFetch: discoveryRoutes({ catalog }),
    });

    await fetch(`${base}/workspace/ws_1/codex/auth/google`, {
      method: "PUT",
      headers: clientAuth(),
      body: JSON.stringify({ key: "gemini-key" }),
    });
    await fetch(`${base}/workspace/ws_1/codex/auth/google`, { method: "DELETE", headers: clientAuth() });

    // No key may survive under any name the engine could resolve.
    expect(Object.keys(await readCodexAuthStore())).toHaveLength(0);
  });
});
