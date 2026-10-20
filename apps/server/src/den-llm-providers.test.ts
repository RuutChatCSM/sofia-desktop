// Guards the server copy of the provider wire parsers against drift.
//
// The server cannot import these from `@sofia/types` at runtime: that package
// exports raw TypeScript and is a devDependency, so the packaged app crashes on
// boot (see `den-llm-providers.ts`). The renderer still imports the canonical
// implementation, so both are exercised here over the same fixtures — a change
// to one without the other fails this test instead of silently diverging in
// production.
import { describe, expect, test } from "bun:test";

import {
  parseLlmProviderConnection as canonicalConnection,
  parseLlmProviderList as canonicalList,
} from "@sofia/types/den/llm-providers";

import {
  parseLlmProviderConnection,
  parseLlmProviderList,
} from "./den-llm-providers.js";

const provider = {
  id: "lpr_abc",
  providerId: "openrouter",
  name: "OpenRouter",
  source: "cloud",
  providerConfig: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "https://openrouter.ai/api/v1" } },
  hasApiKey: true,
  models: [
    { id: "m1", name: "Model One", config: { limit: { context: 128000 } }, createdAt: "2026-10-01T00:00:00Z" },
    { id: "m2", name: "Model Two", config: "{\"limit\":{\"context\":8000}}", createdAt: null },
  ],
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-02T00:00:00Z",
};

const fixtures: unknown[] = [
  { llmProviders: [provider] },
  { llmProviders: [provider, { id: "broken" }, null, 42, { name: "no id" }] },
  { llmProviders: [] },
  { llmProviders: "not-a-list" },
  {},
  null,
  "<html>error</html>",
  { llmProviders: [{ ...provider, models: "not-a-list", providerConfig: "not json" }] },
];

describe("server provider wire parsers", () => {
  test("match the canonical implementation on every list fixture", () => {
    for (const fixture of fixtures) {
      expect(parseLlmProviderList(fixture)).toEqual(canonicalList(fixture));
    }
  });

  test("match the canonical implementation for single-provider payloads", () => {
    const payloads: unknown[] = [
      { llmProvider: { ...provider, apiKey: "sk-test", apiKeys: { A: "1", B: "  " } } },
      { llmProvider: { ...provider, apiKeys: { A: "", B: "" } } },
      { llmProvider: { id: "wrong" } },
      { llmProvider: provider },
      { llmProvider: null },
      {},
      "nope",
    ];
    for (const payload of payloads) {
      expect(parseLlmProviderConnection(payload)).toEqual(canonicalConnection(payload));
      expect(parseLlmProviderConnection(payload, "lpr_abc")).toEqual(canonicalConnection(payload, "lpr_abc"));
    }
  });
});
