import { describe, expect, test } from "bun:test";
import {
  inferAdapter,
  providerToCodexConfig,
  type ModelsDevProvider,
  type ModelsDevModel,
} from "./models-dev.js";

function makeProvider(overrides: Partial<ModelsDevProvider> = {}): ModelsDevProvider {
  return {
    id: "test-provider",
    name: "Test Provider",
    env: ["TEST_API_KEY"],
    npm: "@ai-sdk/openai",
    api: "https://api.test.com/v1",
    models: {
      "test-model": makeModel({ id: "test-model", name: "Test Model" }),
    },
    ...overrides,
  };
}

function makeModel(overrides: Partial<ModelsDevModel> = {}): ModelsDevModel {
  return {
    id: "test-model",
    name: "Test Model",
    tool_call: true,
    reasoning: false,
    attachment: false,
    temperature: true,
    limit: { context: 128000, output: 4096 },
    ...overrides,
  };
}

describe("providerToCodexConfig", () => {
  test("maps provider fields correctly", () => {
    const provider = makeProvider();
    const result = providerToCodexConfig(provider);
    expect(result).toEqual({
      providerId: "test-provider",
      providerName: "Test Provider",
      baseUrl: "https://api.test.com/v1",
      envKey: "TEST_API_KEY",
    });
  });

  test("strips /api/v1 suffix from base URL", () => {
    const provider = makeProvider({ api: "https://api.test.com/api/v1" });
    const result = providerToCodexConfig(provider);
    expect(result.baseUrl).toBe("https://api.test.com");
  });

  test("returns null baseUrl when no api field", () => {
    const provider = makeProvider({ api: undefined });
    const result = providerToCodexConfig(provider);
    expect(result.baseUrl).toBeNull();
  });

  test("returns null envKey when env is empty", () => {
    const provider = makeProvider({ env: [] });
    const result = providerToCodexConfig(provider);
    expect(result.envKey).toBeNull();
  });
});

describe("inferAdapter", () => {
  test("infers anthropic-messages for Anthropic SDK", () => {
    const provider = makeProvider({ npm: "@ai-sdk/anthropic" });
    expect(inferAdapter(provider)).toBe("anthropic-messages");
  });

  test("infers openai-responses for OpenAI SDK", () => {
    const provider = makeProvider({ npm: "@ai-sdk/openai" });
    expect(inferAdapter(provider)).toBe("openai-responses");
  });

  test("infers openai-chat for OpenAI-compatible SDK", () => {
    const provider = makeProvider({ npm: "@ai-sdk/openai-compatible" });
    expect(inferAdapter(provider)).toBe("openai-chat");
  });

  test("infers openai-chat for OpenRouter SDK", () => {
    const provider = makeProvider({ npm: "@openrouter/ai-sdk-provider" });
    expect(inferAdapter(provider)).toBe("openai-chat");
  });

  test("infers google-gemini for Google SDK", () => {
    const provider = makeProvider({ npm: "@ai-sdk/google" });
    expect(inferAdapter(provider)).toBe("google-gemini");
  });

  test("infers bedrock-converse for Bedrock SDK", () => {
    const provider = makeProvider({ npm: "@ai-sdk/amazon-bedrock" });
    expect(inferAdapter(provider)).toBe("bedrock-converse");
  });

  test("defaults to openai-chat for unknown SDK", () => {
    const provider = makeProvider({ npm: "some-other-sdk" });
    expect(inferAdapter(provider)).toBe("openai-chat");
  });

  test("defaults to openai-chat when no npm field", () => {
    const provider = makeProvider({ npm: undefined });
    expect(inferAdapter(provider)).toBe("openai-chat");
  });
});
