import { afterEach, describe, expect, test } from "bun:test";

import { createClient } from "../src/app/lib/engine";
import type { ProviderListItem, WorkspaceDisplay } from "../src/app/types";
import { createProviderAuthStore } from "../src/react-app/domains/connections/provider-auth/store";

const originalWindow = globalThis.window;
const originalFetch = globalThis.fetch;
const engineClient = createClient("https://engine.example", "/tmp/workspace_test", undefined, (input, init) =>
  globalThis.fetch(input, init),
);

function installWindow(options: {
  origin: string;
  electronInfo?: {
    baseUrl: string;
    ownerToken: string;
  };
}) {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => true,
      location: { origin: options.origin },
      __SOFIA_ELECTRON__: options.electronInfo
        ? {
            invokeDesktop: async () => ({
              running: true,
              baseUrl: options.electronInfo?.baseUrl,
              ownerToken: options.electronInfo?.ownerToken,
            }),
          }
        : undefined,
    },
  });
}

/**
 * Mirrors the shape the server derives from the shared connectable catalog
 * (`providerAuthMethodsById()`): a method list per provider, covering every
 * connectable provider rather than a hardcoded OpenAI-only object.
 */
function installProviderAuthFetch(overrides?: Record<string, Array<{ type: string; label: string }>>) {
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async () =>
      new Response(
        JSON.stringify(
          overrides ?? {
            openai: [
              { type: "oauth", label: "Sign in with ChatGPT" },
              { type: "oauth", label: "Headless device flow" },
              { type: "api", label: "API key" },
            ],
            anthropic: [{ type: "api", label: "API key" }],
            openrouter: [{ type: "api", label: "API key" }],
            groq: [{ type: "api", label: "API key" }],
            deepseek: [{ type: "api", label: "API key" }],
            // Catalog-only providers the engine's env-var list never mentions.
            neuralwatt: [{ type: "api", label: "API key" }],
            "qiniu-ai": [{ type: "api", label: "API key" }],
            "umans-ai-coding-plan": [{ type: "api", label: "API key" }],
          },
        ),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  });
}

function createTestStore(workerType: "local" | "remote") {
  const providers: ProviderListItem[] = [
    {
      id: "openai",
      name: "OpenAI",
      env: ["OPENAI_API_KEY"],
      source: "env",
      models: {},
    },
  ];
  const workspace = {
    id: "workspace_test",
    name: "Test workspace",
    path: "/tmp/workspace_test",
    preset: "default",
    workspaceType: workerType,
  } satisfies WorkspaceDisplay;

  return createProviderAuthStore({
    client: () => engineClient,
    providers: () => providers,
    providerDefaults: () => ({}),
    providerConnectedIds: () => [],
    disabledProviders: () => [],
    checkDesktopAppRestriction: () => false,
    selectedWorkspaceDisplay: () => workspace,
    providerBaseUrl: () => "https://engine.example",
    selectedWorkspaceRoot: () => workspace.path,
    runtimeWorkspaceId: () => workspace.id,
    sofiaServer: {
      getSnapshot: () => ({
        sofiaServerStatus: "disconnected",
        sofiaServerClient: null,
        sofiaServerCapabilities: null,
      }),
    },
    setProviders: () => undefined,
    setProviderDefaults: () => undefined,
    setProviderConnectedIds: () => undefined,
    setDisabledProviders: () => undefined,
    markWorkspaceEngineConfigReloadRequired: () => undefined,
  });
}

afterEach(() => {
  Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
});

describe("OpenAI provider auth methods", () => {
  test("desktop local workers offer non-headless OAuth", async () => {
    installWindow({
      origin: "http://localhost:3000",
      electronInfo: { baseUrl: "http://localhost:8787", ownerToken: "owner-token" },
    });
    installProviderAuthFetch();
    const store = createTestStore("local");

    await store.openProviderAuthModal();

    expect(store.getSnapshot().providerAuthMethods.openai).toEqual([
      { type: "oauth", label: "Sign in with ChatGPT", methodIndex: 0 },
      { type: "api", label: "API key", methodIndex: 2 },
    ]);
  });

  test("desktop remote workers offer only headless OAuth", async () => {
    installWindow({
      origin: "http://localhost:3000",
      electronInfo: { baseUrl: "http://localhost:8787", ownerToken: "owner-token" },
    });
    installProviderAuthFetch();
    const store = createTestStore("remote");

    await store.openProviderAuthModal();

    expect(store.getSnapshot().providerAuthMethods.openai).toEqual([
      { type: "oauth", label: "Headless device flow", methodIndex: 1 },
      { type: "api", label: "API key", methodIndex: 2 },
    ]);
  });

  test("browser workers offer API keys without OAuth", async () => {
    installWindow({ origin: "https://self-hosted.example" });
    installProviderAuthFetch();
    const store = createTestStore("local");

    await store.openProviderAuthModal();

    expect(store.getSnapshot().providerAuthMethods.openai).toEqual([
      { type: "api", label: "API key", methodIndex: 2 },
    ]);
  });
});

describe("non-OpenAI provider auth methods", () => {
  test("exposes every provider the engine advertises", async () => {
    installWindow({
      origin: "http://localhost:3000",
      electronInfo: { baseUrl: "http://localhost:8787", ownerToken: "owner-token" },
    });
    installProviderAuthFetch();
    const store = createTestStore("local");

    await store.openProviderAuthModal();

    const methods = store.getSnapshot().providerAuthMethods;
    for (const id of ["anthropic", "openrouter", "groq", "deepseek"]) {
      expect(methods[id]).toEqual([{ type: "api", label: "API key", methodIndex: 0 }]);
    }
  });

  test("never offers oauth for providers the engine cannot complete", async () => {
    installWindow({
      origin: "http://localhost:3000",
      electronInfo: { baseUrl: "http://localhost:8787", ownerToken: "owner-token" },
    });
    installProviderAuthFetch();
    const store = createTestStore("local");

    await store.openProviderAuthModal();

    const methods = store.getSnapshot().providerAuthMethods;
    for (const [id, providerMethods] of Object.entries(methods)) {
      if (id === "openai") continue;
      expect(providerMethods.some((method) => method.type === "oauth")).toBe(false);
    }
  });
});

describe("catalog providers in the connect modal", () => {
  test("surfaces providers that are not yet connected", async () => {
    installWindow({
      origin: "http://localhost:3000",
      electronInfo: { baseUrl: "http://localhost:8787", ownerToken: "owner-token" },
    });
    installProviderAuthFetch();
    const store = createTestStore("local");

    await store.openProviderAuthModal();

    // A provider only in the models.dev catalog must still be connectable, even
    // though it is not in the connected provider list yet.
    const methods = store.getSnapshot().providerAuthMethods;
    expect(methods.neuralwatt).toEqual([{ type: "api", label: "API key", methodIndex: 0 }]);
    expect(methods["qiniu-ai"]).toEqual([{ type: "api", label: "API key", methodIndex: 0 }]);
  });

  test("renders a large catalog without collapsing entries", async () => {
    installWindow({
      origin: "http://localhost:3000",
      electronInfo: { baseUrl: "http://localhost:8787", ownerToken: "owner-token" },
    });
    const many: Record<string, Array<{ type: string; label: string }>> = {
      openai: [{ type: "oauth", label: "Sign in with ChatGPT" }, { type: "api", label: "API key" }],
    };
    for (let index = 0; index < 150; index += 1) {
      many[`gateway-${index}`] = [{ type: "api", label: "API key" }];
    }
    installProviderAuthFetch(many);
    const store = createTestStore("local");

    await store.openProviderAuthModal();

    const methods = store.getSnapshot().providerAuthMethods;
    // The full models.dev catalog, not the fixed 14 the app used to offer.
    expect(Object.keys(methods).length).toBeGreaterThan(150);
    expect(methods["gateway-42"]).toEqual([{ type: "api", label: "API key", methodIndex: 0 }]);
    expect(methods["umans-ai-coding-plan"]).toBeUndefined();
  });
});
