// Tests for the codex config.toml mapper (engine provider map -> codex).
import { describe, expect, it } from "bun:test";

import {
  addCodexDefaultProviderLines,
  buildCodexConfigToml,
  codexConfigTomlFromRuntime,
  codexWireApiForProvider,
  mapWorkspaceEngineProviderToCodex,
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

const anthropic = {
  name: "Anthropic",
  npm: "@ai-sdk/anthropic",
  env: ["ANTHROPIC_API_KEY"],
  options: { baseURL: "https://api.anthropic.com/v1" },
  models: { "claude-sonnet-4": {} },
};

describe("codexWireApiForProvider", () => {
  it("selects the native Anthropic wire for the anthropic provider id", () => {
    expect(codexWireApiForProvider("anthropic", {})).toBe("anthropic");
    expect(codexWireApiForProvider("Anthropic", { api: "https://api.anthropic.com/v1" })).toBe("anthropic");
  });

  it("selects the native Anthropic wire from the @ai-sdk/anthropic npm field", () => {
    expect(codexWireApiForProvider("custom-claude", { npm: "@ai-sdk/anthropic" })).toBe("anthropic");
    expect(codexWireApiForProvider("custom-claude", { options: { npm: "@ai-sdk/anthropic" } })).toBe("anthropic");
  });

  it("still selects Responses for OpenAI and chat completions for others", () => {
    expect(codexWireApiForProvider("openai", {})).toBe("responses");
    expect(codexWireApiForProvider("custom", { npm: "@ai-sdk/openai" })).toBe("responses");
    expect(codexWireApiForProvider("custom", {})).toBe("chatcompletions");
  });

  it("honors an explicit anthropic wire value", () => {
    expect(codexWireApiForProvider("custom", { wireApi: "anthropic" })).toBe("anthropic");
    expect(codexWireApiForProvider("custom", { wire_api: "anthropic" })).toBe("anthropic");
    expect(codexWireApiForProvider("custom", { options: { wireApi: "anthropic" } })).toBe("anthropic");
  });
});

describe("mapWorkspaceEngineProviderToCodex", () => {
  it("maps baseURL + env + name", () => {
    const mapped = mapWorkspaceEngineProviderToCodex("deepseek", deepseek);
    expect(mapped).toEqual({
      name: "DeepSeek",
      baseUrl: "https://api.deepseek.com",
      envKey: "DEEPSEEK_API_KEY",
      wireApi: "chatcompletions",
    });
  });

  it("maps the anthropic provider to the native Anthropic wire", () => {
    const mapped = mapWorkspaceEngineProviderToCodex("anthropic", anthropic);
    expect(mapped?.wireApi).toBe("anthropic");
  });

  it("strips a trailing /api/v1 suffix", () => {
    const mapped = mapWorkspaceEngineProviderToCodex("x", {
      options: { baseURL: "https://example.com/api/v1" },
    });
    expect(mapped?.baseUrl).toBe("https://example.com");
  });

  it("returns null when no base_url/api is present", () => {
    expect(mapWorkspaceEngineProviderToCodex("x", { name: "No URL" })).toBeNull();
  });

  it("falls back to the provider api field", () => {
    const mapped = mapWorkspaceEngineProviderToCodex("x", { api: "https://api.example.com/api/v1" });
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

  it("uses the native Anthropic wire for the anthropic provider", () => {
    const toml = buildCodexConfigToml({ anthropic });
    expect(toml).toContain("[model_providers.anthropic]");
    expect(toml).toContain('base_url = "https://api.anthropic.com/v1"');
    expect(toml).toContain('wire_api = "anthropic"');
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
