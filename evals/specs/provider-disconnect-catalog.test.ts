import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { test } from "@sofia/testkit";
import {
  readCodexEngineConfig,
  removeCodexProvider,
  writeCodexProviders,
} from "../../apps/server/src/codex-providers.ts";
import { parseModelsDevCatalog } from "../../apps/server/src/models-dev-catalog.ts";

test("Anthropic models remain available when the catalog omits an OpenAI-compatible endpoint", () => {
  const providers = parseModelsDevCatalog({ anthropic: {
    id: "anthropic", name: "Anthropic", env: ["ANTHROPIC_API_KEY"],
    models: { "claude-test": { id: "claude-test", name: "Claude Test" } },
  } });
  expect(providers.find((provider) => provider.id === "anthropic")?.models.map((model) => model.id)).toEqual(["claude-test"]);
});

test("Disconnect removes a provider from the persisted model picker catalog", async () => {
  const root = await mkdtemp(join(tmpdir(), "sofia-provider-disconnect-"));
  const env = { SOFIA_PROVIDER_HOME: root };
  try {
    await writeCodexProviders({ providers: {
      openrouter: {
        api_key: "", base_url: "https://openrouter.ai/api/v1", wire_api: "chat_completions",
        name: "OpenRouter", models: [{ id: "openrouter/auto", name: "Auto", reasoning: true }],
      },
      anthropic: {
        api_key: "", base_url: "https://api.anthropic.com/v1", wire_api: "chat_completions",
        name: "Anthropic", models: [{ id: "claude-test", name: "Claude", reasoning: true }],
      },
    } }, { env });
    await removeCodexProvider("openrouter", { env });
    const afterRestart = await readCodexEngineConfig({ env });
    expect(afterRestart.providers.map((provider) => provider.providerId)).toEqual(["anthropic"]);
    expect(afterRestart.providers[0].models.map((model) => model.id)).toEqual(["claude-test"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
