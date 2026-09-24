// Tests for the codex-native providers.json catalog, config.toml generation and
// the engine provider-map sync.
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "bun:test";

import {
  codexConfigTomlFromEngineConfig,
  codexEnvKeyForProvider,
  readCodexEngineConfig,
  readCodexProviders,
  writeCodexEngineConfigFromProviders,
  writeCodexProviders,
  type CodexProvidersFile,
} from "./codex-providers.js";
import {
  discoverProviderModels,
  parseModelsPayload,
  resetProviderModelDiscoveryCache,
} from "./codex-model-discovery.js";

let tempDirs: string[] = [];

afterEach(() => {
  tempDirs = [];
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "codex-providers-"));
  tempDirs.push(dir);
  return dir;
}

describe("codexEnvKeyForProvider", () => {
  it("derives codex's `<ID>_API_KEY` name", () => {
    expect(codexEnvKeyForProvider("deepseek")).toBe("DEEPSEEK_API_KEY");
    expect(codexEnvKeyForProvider("xiaomi-token-plan-sgp")).toBe("XIAOMI_TOKEN_PLAN_SGP_API_KEY");
  });
});

describe("readCodexEngineConfig", () => {
  it("returns empty config when providers.json is missing", async () => {
    const dir = await tempDir();
    const config = await readCodexEngineConfig({
      path: join(dir, "providers.json"),
      tomlPath: join(dir, "config.toml"),
    });
    expect(config.defaultProviderId).toBeNull();
    expect(config.model).toBeNull();
    expect(config.providers).toEqual([]);
  });

  it("flattens providers.json + config.toml selection", async () => {
    const dir = await tempDir();
    const providersPath = join(dir, "providers.json");
    await writeFile(providersPath, JSON.stringify({
      providers: {
        deepseek: {
          api_key: "sk-test",
          base_url: "https://api.deepseek.com",
          wire_api: "chatcompletions",
          name: "DeepSeek",
          models: [
            { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", reasoning: true },
            { id: "deepseek-v4-flash", name: "DeepSeek V4.1 Flash", reasoning: true },
          ],
        },
        openai: {
          api_key: "",
          base_url: "https://api.openai.com",
          wire_api: "responses",
          name: "OpenAI",
          models: [],
        },
      },
    }));
    await writeFile(join(dir, "config.toml"), 'model_provider = "deepseek"\nmodel = "deepseek-v4-flash"\n');

    const config = await readCodexEngineConfig({ path: providersPath, tomlPath: join(dir, "config.toml") });
    expect(config.defaultProviderId).toBe("deepseek");
    expect(config.model).toBe("deepseek-v4-flash");
    expect(config.providers.map((p) => p.providerId)).toEqual(["deepseek", "openai"]);
    expect(config.providers[0].envKey).toBe("DEEPSEEK_API_KEY");
    expect(config.providers[1].wireApi).toBe("responses");
    expect(config.providers[0].models).toHaveLength(2);
  });

  it("defaults to the first provider/model when config.toml has no selection", async () => {
    const dir = await tempDir();
    const providersPath = join(dir, "providers.json");
    await writeCodexProviders(
      {
        providers: {
          deepseek: {
            api_key: "",
            base_url: "https://api.deepseek.com",
            wire_api: "chatcompletions",
            name: "DeepSeek",
            models: [{ id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", reasoning: true }],
          },
        },
      },
      { path: providersPath },
    );
    const config = await readCodexEngineConfig({ path: providersPath, tomlPath: join(dir, "missing.toml") });
    expect(config.defaultProviderId).toBe("deepseek");
    expect(config.model).toBe("deepseek-v4-pro");
  });
});

describe("readCodexProviders", () => {
  it("round-trips the codex providers.json shape", async () => {
    const dir = await tempDir();
    const path = join(dir, "providers.json");
    const input: CodexProvidersFile = {
      providers: {
        deepseek: {
          api_key: "sk-test",
          base_url: "https://api.deepseek.com",
          wire_api: "chatcompletions",
          name: "DeepSeek",
          models: [{ id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", reasoning: true, contextWindow: 1_048_576 }],
        },
      },
    };
    await writeCodexProviders(input, { path });
    expect(await readCodexProviders({ path })).toEqual(input);
  });
});

describe("codexConfigTomlFromEngineConfig", () => {
  it("emits every provider with the derived env_key and no inline bearer token", () => {
    const toml = codexConfigTomlFromEngineConfig({
      defaultProviderId: "deepseek",
      model: "deepseek-v4-pro",
      providers: [
        {
          providerId: "deepseek",
          providerName: "DeepSeek",
          baseUrl: "https://api.deepseek.com",
          envKey: "DEEPSEEK_API_KEY",
          wireApi: "chatcompletions",
          models: [{ id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", reasoning: true, contextWindow: 1_048_576 }],
        },
        {
          providerId: "openai",
          providerName: "OpenAI",
          baseUrl: "https://api.openai.com",
          envKey: "OPENAI_API_KEY",
          wireApi: "responses",
          models: [],
        },
      ],
    });
    expect(toml.startsWith('model_provider = "deepseek"\nmodel = "deepseek-v4-pro"\nmodel_context_window = 1048576\n')).toBe(true);
    expect(toml).toContain("[model_providers.deepseek]");
    expect(toml).toContain("[model_providers.openai]");
    expect(toml).toContain('env_key = "DEEPSEEK_API_KEY"');
    expect(toml).toContain('env_key = "OPENAI_API_KEY"');
    expect(toml).not.toContain("experimental_bearer_token");
  });

  it("returns empty for a config with no providers", () => {
    expect(codexConfigTomlFromEngineConfig({ defaultProviderId: null, model: null, providers: [] })).toBe("");
  });
});

describe("discoverProviderModels", () => {
  it("fills an empty provider catalog from the provider's /models endpoint", async () => {
    resetProviderModelDiscoveryCache();
    const dir = await tempDir();
    const env = { SOFIA_PROVIDER_HOME: dir } as NodeJS.ProcessEnv;
    await writeCodexProviders({
      providers: {
        xiaomi: {
          api_key: "sk-xiaomi",
          base_url: "https://api.xiaomimimo.com/v1",
          wire_api: "chatcompletions",
          name: "Xiaomi",
          models: [],
        },
        deepseek: {
          api_key: "sk-deepseek",
          base_url: "https://api.deepseek.com",
          wire_api: "chatcompletions",
          name: "DeepSeek",
          models: [{ id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", reasoning: true }],
        },
      },
    }, { env });

    const requests: string[] = [];
    const fetchImpl = (async (url: string) => {
      requests.push(url);
      return new Response(JSON.stringify({ object: "list", data: [
        { id: "mimo-v2.5", object: "model" },
        { id: "mimo-v2.5-pro", object: "model" },
        { id: "mimo-v2.5-asr", object: "model" },
        { id: "mimo-v2.5-tts", object: "model" },
        { id: "mimo-v2.5-tts-voiceclone", object: "model" },
      ] }), { status: 200 });
    }) as unknown as typeof fetch;

    const file = await discoverProviderModels({ env, fetchImpl });
    expect(requests).toEqual(["https://api.xiaomimimo.com/v1/models"]);
    expect(file.providers.xiaomi.models.map((model) => model.id)).toEqual(["mimo-v2.5", "mimo-v2.5-pro"]);
    // A provider that already has a catalog is never probed or rewritten.
    expect(file.providers.deepseek.models.map((model) => model.id)).toEqual(["deepseek-v4-pro"]);

    // The resolved catalog is persisted so later reads do not re-fetch.
    const persisted = await readCodexProviders({ env });
    expect(persisted.providers.xiaomi.models.map((model) => model.id)).toEqual(["mimo-v2.5", "mimo-v2.5-pro"]);
    expect(persisted.providers.xiaomi.api_key).toBe("sk-xiaomi");
  });

  it("keeps the provider intact when /models is unreachable", async () => {
    resetProviderModelDiscoveryCache();
    const dir = await tempDir();
    const env = { SOFIA_PROVIDER_HOME: dir } as NodeJS.ProcessEnv;
    await writeCodexProviders({
      providers: {
        xiaomi: {
          api_key: "sk-xiaomi",
          base_url: "https://api.xiaomimimo.com/v1",
          wire_api: "chatcompletions",
          name: "Xiaomi",
          models: [],
        },
      },
    }, { env });

    const fetchImpl = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    const file = await discoverProviderModels({ env, fetchImpl });
    expect(file.providers.xiaomi.models).toEqual([]);
    expect((await readCodexProviders({ env })).providers.xiaomi.models).toEqual([]);
  });

  it("parses the OpenAI envelope, a bare array and rejects non-chat models", () => {
    expect(parseModelsPayload({ data: [{ id: "a" }] }).map((model) => model.id)).toEqual(["a"]);
    expect(parseModelsPayload(["b"]).map((model) => model.id)).toEqual(["b"]);
    expect(parseModelsPayload({ models: [{ id: "c" }] }).map((model) => model.id)).toEqual(["c"]);
    expect(parseModelsPayload({ data: [{ id: "text-embedding-3" }, { id: "whisper-1" }] })).toEqual([]);
  });
});

describe("writeCodexEngineConfigFromProviders", () => {
  it("preserves CLI-connected providers the app push does not know about", async () => {
    const dir = await tempDir();
    const env = { SOFIA_PROVIDER_HOME: dir } as NodeJS.ProcessEnv;
    await writeCodexProviders({
      providers: {
        xiaomi: {
          api_key: "sk-xiaomi",
          base_url: "https://api.xiaomimimo.com/v1",
          wire_api: "chatcompletions",
          name: "Xiaomi",
          models: [{ id: "mimo-v2.5", name: "mimo-v2.5", reasoning: true }],
        },
      },
    }, { env });

    await writeCodexEngineConfigFromProviders([
      {
        providerId: "deepseek",
        providerName: "DeepSeek",
        baseUrl: "https://api.deepseek.com",
        envKey: "DEEPSEEK_API_KEY",
        wireApi: "chatcompletions",
        models: [{ id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", reasoning: true }],
      },
    ], { env });

    const persisted = await readCodexProviders({ env });
    expect(Object.keys(persisted.providers).sort()).toEqual(["deepseek", "xiaomi"]);
    expect(persisted.providers.xiaomi.api_key).toBe("sk-xiaomi");
  });
});
