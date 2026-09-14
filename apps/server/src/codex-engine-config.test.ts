// Tests for codexengine.json (read/write/toml generation/sync).
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "bun:test";

import {
  codexConfigTomlFromEngineConfig,
  readCodexEngineConfig,
  syncCodexEngineConfigFromProviderMap,
  writeCodexEngineConfig,
  type CodexEngineConfig,
} from "./codex-engine-config.js";

let tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "codex-engine-config-"));
  tempDirs.push(dir);
  return dir;
}

async function tempFilePath(name = "codexengine.json"): Promise<string> {
  const dir = await tempDir();
  return join(dir, name);
}

afterEach(() => {
  tempDirs = [];
});

describe("readCodexEngineConfig", () => {
  it("returns empty config when file is missing", async () => {
    const config = await readCodexEngineConfig({ path: await tempFilePath() });
    expect(config.defaultProviderId).toBeNull();
    expect(config.model).toBeNull();
    expect(config.providers).toEqual([]);
  });

  it("parses a multi-provider config", async () => {
    const path = await tempFilePath();
    await writeFile(path, JSON.stringify({
      defaultProviderId: "deepseek",
      model: "deepseek-v4-pro",
      providers: [
        {
          providerId: "deepseek",
          providerName: "DeepSeek",
          baseUrl: "https://api.deepseek.com",
          envKey: "DEEPSEEK_API_KEY",
          wireApi: "chatcompletions",
          models: [],
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
    }));
    const config = await readCodexEngineConfig({ path });
    expect(config.model).toBe("deepseek-v4-pro");
    expect(config.defaultProviderId).toBe("deepseek");
    expect(config.providers).toHaveLength(2);
    expect(config.providers[0].baseUrl).toBe("https://api.deepseek.com");
    expect(config.providers[1].envKey).toBe("OPENAI_API_KEY");
    expect(config.providers[0].wireApi).toBe("chatcompletions");
    expect(config.providers[1].wireApi).toBe("responses");
  });

  it("migrates a legacy single-provider config", async () => {
    const path = await tempFilePath();
    await writeFile(path, JSON.stringify({
      model: "deepseek-v4-pro",
      providerId: "deepseek",
      providerName: "DeepSeek",
      baseUrl: "https://api.deepseek.com",
      envKey: "DEEPSEEK_API_KEY",
    }));
    const config = await readCodexEngineConfig({ path });
    expect(config.defaultProviderId).toBe("deepseek");
    expect(config.providers).toHaveLength(1);
    expect(config.providers[0].baseUrl).toBe("https://api.deepseek.com");
    expect(config.providers[0].wireApi).toBe("chatcompletions");
  });
});

describe("writeCodexEngineConfig", () => {
  it("writes and re-reads", async () => {
    const path = await tempFilePath();
    const input: CodexEngineConfig = {
      defaultProviderId: "openai",
      model: "gpt-4.1",
      providers: [
        {
          providerId: "openai",
          providerName: "OpenAI",
          baseUrl: "https://api.openai.com",
          envKey: "OPENAI_API_KEY",
          wireApi: "responses",
          models: [],
        },
      ],
    };
    await writeCodexEngineConfig(input, { path });
    const config = await readCodexEngineConfig({ path });
    expect(config).toEqual(input);
  });
});

describe("codexConfigTomlFromEngineConfig", () => {
  it("emits every provider as a model_providers table", () => {
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
          models: [],
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
    expect(toml.startsWith('model_provider = "deepseek"\nmodel = "deepseek-v4-pro"\n')).toBe(true);
    expect(toml).toContain("[model_providers.deepseek]");
    expect(toml).toContain("[model_providers.openai]");
    expect(toml).toContain('base_url = "https://api.deepseek.com"');
    expect(toml).toContain('env_key = "OPENAI_API_KEY"');
    expect(toml).toContain('wire_api = "chatcompletions"');
    expect(toml).toContain('wire_api = "responses"');
  });

  it("returns empty for a config with no providers", () => {
    const toml = codexConfigTomlFromEngineConfig({ ...EMPTY() });
    expect(toml).toBe("");
  });
});

describe("syncCodexEngineConfigFromProviderMap", () => {
  it("carries ALL providers, not just the first", async () => {
    const path = await tempFilePath();
    await syncCodexEngineConfigFromProviderMap(
      {
        deepseek: {
          name: "DeepSeek",
          env: ["DEEPSEEK_API_KEY"],
          options: { baseURL: "https://api.deepseek.com" },
          models: { "deepseek-v4-pro": {}, "deepseek-v4-flash": {} },
        },
        openai: {
          name: "OpenAI",
          env: ["OPENAI_API_KEY"],
          options: { baseURL: "https://api.openai.com" },
          models: { "gpt-4.1": {} },
        },
      },
      { path },
    );
    const raw = JSON.parse(await readFile(path, "utf8"));
    expect(raw.defaultProviderId).toBe("deepseek");
    expect(raw.model).toBe("deepseek-v4-pro");
    expect(raw.providers.map((p: { providerId: string }) => p.providerId)).toEqual(["deepseek", "openai"]);
    expect(raw.providers.map((p: { wireApi: string }) => p.wireApi)).toEqual(["chatcompletions", "responses"]);
  });

  it("skips providers without a base url", async () => {
    const path = await tempFilePath();
    const result = await syncCodexEngineConfigFromProviderMap(
      { noUrl: { name: "No URL", models: {} } },
      { path },
    );
    expect(result).toBeNull();
  });
});

function EMPTY(): CodexEngineConfig {
  return {
    defaultProviderId: null,
    model: null,
    providers: [],
  };
}
