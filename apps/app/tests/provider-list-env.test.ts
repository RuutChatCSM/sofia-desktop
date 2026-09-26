// Coverage for the engine -> app provider list bridge.
//
// Regression this pins: `buildProviderList` hardcoded `env: []` for every
// provider. The provider-auth flow reads `env` to decide which providers can
// take an API key and which env name the key is written under, so an empty list
// hid every provider from the connect modal and silently dropped pasted keys.
import { afterEach, describe, expect, test } from "bun:test";

import { createClient } from "../src/app/lib/engine";

const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;

afterEach(() => {
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
  Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
});

function installConfigFetch(config: unknown) {
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async () =>
      new Response(JSON.stringify({ ok: true, config }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });
}

function createEngineClient() {
  return createClient("https://engine.example", "/tmp/workspace_env_test", "ws_1", (input, init) =>
    globalThis.fetch(input, init),
  );
}

const engineConfig = {
  defaultProviderId: "anthropic",
  model: "claude-sonnet-4",
  providers: [
    {
      providerId: "anthropic",
      providerName: "Anthropic",
      baseUrl: "https://api.anthropic.com/v1",
      envKey: "ANTHROPIC_API_KEY",
      models: [{ id: "claude-sonnet-4", name: "Claude Sonnet 4" }],
    },
    {
      providerId: "google",
      providerName: "Google Gemini",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      // The engine's env var does not follow `<ID>_API_KEY`; it must survive.
      envKey: "GEMINI_API_KEY",
      models: [{ id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" }],
    },
  ],
};

describe("engine provider list", () => {
  test("surfaces the engine's env var for each provider", async () => {
    installConfigFetch(engineConfig);
    const client = createEngineClient();

    const result = await client.provider.list();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const byId = new Map(result.data.all.map((provider) => [provider.id, provider]));
    expect(byId.get("anthropic")?.env).toEqual(["ANTHROPIC_API_KEY"]);
    expect(byId.get("google")?.env).toEqual(["GEMINI_API_KEY"]);
  });

  test("surfaces the provider base url", async () => {
    installConfigFetch(engineConfig);
    const client = createEngineClient();

    const result = await client.provider.list();
    if (!result.ok) throw new Error("expected provider list");

    const anthropic = result.data.all.find((provider) => provider.id === "anthropic");
    expect(anthropic?.options?.baseURL).toBe("https://api.anthropic.com/v1");
  });

  test("reports an empty env list only when the engine sends none", async () => {
    installConfigFetch({
      defaultProviderId: "custom",
      model: "m",
      providers: [{ providerId: "custom", providerName: "Custom", models: [] }],
    });
    const client = createEngineClient();

    const result = await client.provider.list();
    if (!result.ok) throw new Error("expected provider list");

    expect(result.data.all[0]?.env).toEqual([]);
    expect(result.data.all[0]?.options?.baseURL).toBeUndefined();
  });
});
