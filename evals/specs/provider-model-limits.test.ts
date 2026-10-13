import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect } from "vitest";
import { test } from "@sofia/testkit";
import { parseModelsPayload, mergeProviderModelMetadata, discoverProviderModels, resetProviderModelDiscoveryCache } from "../../apps/server/src/codex-model-discovery";
import { parseCodexEngineConfig, writeCodexProviders, readCodexProviders } from "../../apps/server/src/codex-providers";
import { providerModelContextWindow } from "../../apps/server/src/codex-model-limits";

test("live model discovery retains advertised context and stricter input caps", () => {
  const models = parseModelsPayload({ data: [
    { id: "context", context_length: 1_000_000, max_input_tokens: 200_000 },
    { id: "nested", limit: { context: "131072", input: 120_000 }, reasoning: false },
    { id: "unknown-alias" },
  ] });
  expect(models).toEqual([
    { id: "context", name: "context", reasoning: true, contextWindow: 200_000 },
    { id: "nested", name: "nested", reasoning: false, contextWindow: 120_000 },
    { id: "unknown-alias", name: "unknown-alias", reasoning: true, contextWindow: null },
  ]);
  expect(providerModelContextWindow({ context_window: -1, max_input_tokens: "invalid", limit: { context: 0 } })).toBeNull();
});

test("catalog metadata enriches exact IDs without replacing live models or alias guessing", () => {
  const merged = mergeProviderModelMetadata([
    { id: "known", name: "Gateway label", reasoning: true },
    { id: "ClaudeFable5", name: "Claude Fable 5", reasoning: true },
    { id: "strict", name: "Strict", reasoning: false, contextWindow: 100_000 },
  ], [
    { id: "known", name: "Catalog label", reasoning: false, contextWindow: 200_000 },
    { id: "claude-fable-5", name: "Alias-like", reasoning: true, contextWindow: 200_000 },
    { id: "strict", name: "Strict", reasoning: true, contextWindow: 1_000_000 },
  ]);
  expect(merged).toEqual([
    { id: "known", name: "Gateway label", reasoning: true, contextWindow: 200_000 },
    { id: "ClaudeFable5", name: "Claude Fable 5", reasoning: true },
    { id: "strict", name: "Strict", reasoning: false, contextWindow: 100_000 },
  ]);
});

test("provider config normalization preserves endpoint input limits", () => {
  const config = parseCodexEngineConfig({ defaultProviderId: "gateway", providers: [{ providerId: "gateway", models: [{ id: "m", limit: { context: 1_000_000 }, max_input_tokens: 200_000 }] }] });
  expect(config.providers[0].models[0].contextWindow).toBe(200_000);
});


test("nonempty catalogs with missing limits refresh without deleting live-only models", async () => {
  const home = await mkdtemp(join(tmpdir(), "sofia-model-limits-"));
  const env = { SOFIA_HOME: home };
  resetProviderModelDiscoveryCache();
  try {
    await writeCodexProviders({ providers: { gateway: { name: "Gateway", api_key: "", base_url: "https://provider.invalid/v1", wire_api: "chat_completions", models: [
      { id: "known", name: "Custom name", reasoning: false },
      { id: "local-only", name: "Local", reasoning: true },
    ] } } }, { env });
    let requests = 0;
    const fetchImpl: typeof fetch = async () => { requests += 1; return Response.json({ data: [{ id: "known", max_input_tokens: 200_000 }] }); };
    const result = await discoverProviderModels({ env, fetchImpl, now: () => 1_000 });
    expect(result.providers.gateway.models).toEqual([
      { id: "known", name: "Custom name", reasoning: false, contextWindow: 200_000 },
      { id: "local-only", name: "Local", reasoning: true, contextWindow: null },
    ]);
    expect((await readCodexProviders({ env })).providers.gateway.models[0].contextWindow).toBe(200_000);
    await discoverProviderModels({ env, fetchImpl, now: () => 1_001 });
    expect(requests).toBe(1);
  } finally {
    await rm(home, { recursive: true, force: true });
    resetProviderModelDiscoveryCache();
  }
});
