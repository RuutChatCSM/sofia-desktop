// Tests for the codex config.toml mapper (opencode provider map -> codex).
import { describe, expect, it } from "bun:test";

import {
  addCodexDefaultProviderLines,
  buildCodexConfigToml,
  codexConfigTomlFromRuntime,
  mapOpencodeProviderToCodex,
  pickDefaultCodexProvider,
} from "./codex-config.js";

const deepseek = {
  name: "DeepSeek",
  npm: "@ai-sdk/openai-compatible",
  env: ["DEEPSEEK_API_KEY"],
  options: { baseURL: "https://api.deepseek.com" },
  models: {
    "deepseek-v4-pro": {},
    "deepseek-v4-flash": {},
  },
};

describe("mapOpencodeProviderToCodex", () => {
  it("maps baseURL + env + name", () => {
    const mapped = mapOpencodeProviderToCodex("deepseek", deepseek);
    expect(mapped).toEqual({
      name: "DeepSeek",
      baseUrl: "https://api.deepseek.com",
      envKey: "DEEPSEEK_API_KEY",
      wireApi: "chatcompletions",
    });
  });

  it("strips a trailing /api/v1 suffix", () => {
    const mapped = mapOpencodeProviderToCodex("x", {
      options: { baseURL: "https://example.com/api/v1" },
    });
    expect(mapped?.baseUrl).toBe("https://example.com");
  });

  it("returns null when no base_url/api is present", () => {
    expect(mapOpencodeProviderToCodex("x", { name: "No URL" })).toBeNull();
  });

  it("falls back to the provider api field", () => {
    const mapped = mapOpencodeProviderToCodex("x", { api: "https://api.example.com/api/v1" });
    expect(mapped?.baseUrl).toBe("https://api.example.com");
  });
});

describe("buildCodexConfigToml", () => {
  it("uses chat completions for OpenAI-compatible third-party providers", () => {
    const toml = buildCodexConfigToml({ deepseek });
    expect(toml).toContain("[model_providers.deepseek]");
    expect(toml).toContain('name = "DeepSeek"');
    expect(toml).toContain('base_url = "https://api.deepseek.com"');
    expect(toml).toContain('wire_api = "chatcompletions"');
    expect(toml).toContain('env_key = "DEEPSEEK_API_KEY"');
  });

  it("uses Responses for the official OpenAI provider and honors an explicit override", () => {
    const toml = buildCodexConfigToml({
      openai: {
        name: "OpenAI",
        npm: "@ai-sdk/openai",
        api: "https://api.openai.com/v1",
        env: ["OPENAI_API_KEY"],
      },
      proxy: {
        name: "Responses proxy",
        api: "https://proxy.example.com/v1",
        wireApi: "responses",
      },
    });
    expect(toml).toContain('[model_providers.openai]');
    expect(toml.match(/wire_api = "responses"/g)).toHaveLength(2);
  });

  it("skips providers that cannot be represented", () => {
    const toml = buildCodexConfigToml({ noUrl: { name: "No URL" }, deepseek });
    expect(toml).not.toContain("noUrl");
    expect(toml).toContain("deepseek");
  });

  it("returns empty string for an empty map", () => {
    expect(buildCodexConfigToml({})).toBe("");
  });
});

describe("pickDefaultCodexProvider", () => {
  it("picks the first representable provider and its first model", () => {
    const pick = pickDefaultCodexProvider({ noUrl: { name: "x" }, deepseek });
    expect(pick).toEqual({ providerId: "deepseek", model: "deepseek-v4-pro" });
  });
});

describe("addCodexDefaultProviderLines", () => {
  it("prepends model_provider + model", () => {
    const body = buildCodexConfigToml({ deepseek });
    const out = addCodexDefaultProviderLines(body, { deepseek });
    expect(out.startsWith('model_provider = "deepseek"\nmodel = "deepseek-v4-pro"\n')).toBe(true);
  });
});

describe("codexConfigTomlFromRuntime", () => {
  it("builds a full config from a runtime config shape", () => {
    const toml = codexConfigTomlFromRuntime({ provider: { deepseek } });
    expect(toml).toContain("model_provider");
    expect(toml).toContain("[model_providers.deepseek]");
    expect(toml).toContain('wire_api = "chatcompletions"');
  });
});
