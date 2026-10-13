import { describe, expect, test } from "bun:test";

import {
  parseLlmProviderConnection,
  parseLlmProviderList,
} from "@sofia/types/den/llm-providers";

// The payload Sofia Cloud's Rails desktop contract serves at
// `/api/den/v1/llm-providers`: a managed provider whose id is NOT a Den
// `lpr_...` TypeID. Requiring that prefix here is what broke cloud models.
const sofiaCloudProvider = {
  id: "sofia-cloud",
  source: "sofia",
  providerId: "sofia",
  name: "Sofia Cloud",
  hasApiKey: true,
  providerConfig: {
    npm: "@ai-sdk/openai-compatible",
    options: { baseURL: "https://cloud.example.test/v1" },
  },
  models: [
    {
      id: "sofia/gpt-5",
      name: "GPT-5",
      config: { limit: { context: 400000 } },
      createdAt: "2026-09-01T00:00:00.000Z",
    },
  ],
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

const denProvider = { ...sofiaCloudProvider, id: "lpr_01jbvw04hme008000000000000", source: "custom", providerId: "openai" };

describe("parseLlmProviderList", () => {
  test("accepts a backend-agnostic provider id (Sofia Cloud's `sofia-cloud`)", () => {
    const parsed = parseLlmProviderList({ llmProviders: [sofiaCloudProvider] });
    expect(parsed?.providers.map((provider) => provider.id)).toEqual(["sofia-cloud"]);
    expect(parsed?.providers[0]?.models.map((model) => model.id)).toEqual(["sofia/gpt-5"]);
    expect(parsed?.unreadable).toEqual([]);
  });

  test("still accepts Den's `lpr_...` TypeIDs", () => {
    const parsed = parseLlmProviderList({ llmProviders: [denProvider] });
    expect(parsed?.providers.map((provider) => provider.id)).toEqual([denProvider.id]);
  });

  test("returns null when the payload is not a provider list at all", () => {
    expect(parseLlmProviderList({ error: "unauthorized" })).toBeNull();
    expect(parseLlmProviderList(null)).toBeNull();
    expect(parseLlmProviderList({ llmProviders: {} })).toBeNull();
    expect(parseLlmProviderList("<html></html>")).toBeNull();
  });

  test("reports an unreadable row instead of discarding the whole list", () => {
    const parsed = parseLlmProviderList({ llmProviders: [{ name: "no id" }, sofiaCloudProvider] });
    expect(parsed?.providers.map((provider) => provider.id)).toEqual(["sofia-cloud"]);
    expect(parsed?.unreadable).toEqual([{ id: "", name: "no id" }]);
  });

  test("drops an unreadable model without dropping its provider", () => {
    const parsed = parseLlmProviderList({
      llmProviders: [{ ...sofiaCloudProvider, models: [{ id: "model-x" }, ...sofiaCloudProvider.models] }],
    });
    expect(parsed?.providers[0]?.models.map((model) => model.id)).toEqual(["sofia/gpt-5"]);
  });

  test("tolerates a missing or non-array models field", () => {
    expect(parseLlmProviderList({ llmProviders: [{ ...sofiaCloudProvider, models: undefined }] })?.providers[0]?.models).toEqual([]);
    expect(parseLlmProviderList({ llmProviders: [{ ...sofiaCloudProvider, models: "nope" }] })?.providers[0]?.models).toEqual([]);
  });

  test("parses JSON-encoded config, which MariaDB returns as text", () => {
    const parsed = parseLlmProviderList({
      llmProviders: [{ ...sofiaCloudProvider, providerConfig: '{"env":["SOFIA_API_KEY"]}' }],
    });
    expect(parsed?.providers[0]?.providerConfig).toEqual({ env: ["SOFIA_API_KEY"] });
  });
});

describe("parseLlmProviderConnection", () => {
  test("reads apiKey and filters empty apiKeys entries", () => {
    const connection = parseLlmProviderConnection({
      llmProvider: { ...sofiaCloudProvider, apiKey: "sk-sofia-1", apiKeys: { A: "a", B: "" } },
    });
    expect(connection?.apiKey).toBe("sk-sofia-1");
    expect(connection?.apiKeys).toEqual({ A: "a" });
  });

  test("asserts the requested provider id when one is given", () => {
    expect(parseLlmProviderConnection({ llmProvider: sofiaCloudProvider }, "sofia-cloud")?.id).toBe("sofia-cloud");
    expect(parseLlmProviderConnection({ llmProvider: sofiaCloudProvider }, "lpr_other")).toBeNull();
  });

  test("returns null without an llmProvider envelope", () => {
    expect(parseLlmProviderConnection({})).toBeNull();
    expect(parseLlmProviderConnection(null)).toBeNull();
  });
});
