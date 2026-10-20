// Registers the free-tier provider with the app-owned engine catalog.
//
// The engine is codex-derived: its picker reads `providers.json`, and
// `config.toml` is regenerated from that file with `[model_providers.<id>]`
// entries (`base_url`, `wire_api`, `env_key`). An earlier version wrote an
// opencode-style `{ options: { baseURL } }` entry into the runtime `provider`
// map — the engine ignores that shape, which is why the models never appeared.
//
// The provider needs no real credential: the loopback gateway ignores
// Authorization, but the engine requires `env_key` to resolve to something, so
// a fixed placeholder is stored alongside it.
import {
  codexEnvKeyForProvider,
  readCodexProviders,
  writeCodexProviders,
  type CodexProviderModel,
  type CodexProviderRecord,
} from "./codex-providers.js";
import { removeCodexAuthKey, setCodexAuthKey } from "./codex-auth-store.js";
import type { FreeTierConfig } from "./free-tier-config.js";

export const FREE_TIER_PLACEHOLDER_KEY = "sofia-free";

/** Engine-catalog record for the loopback provider. */
export function freeTierProviderRecord(
  config: FreeTierConfig,
  loopbackBaseUrl: string,
): CodexProviderRecord {
  const models: CodexProviderModel[] = config.models.map((model) => ({
    id: model.id,
    name: model.name ?? model.id,
    // The upstream reasoning models emit `reasoning_content`; marking them
    // reasoning keeps the engine from rejecting that field.
    reasoning: true,
    // Always present: the provider-file reader normalizes a missing window to
    // null, so omitting it would make every rewrite look like a change.
    contextWindow: model.contextWindow ?? null,
  }));
  return {
    api_key: FREE_TIER_PLACEHOLDER_KEY,
    base_url: `${loopbackBaseUrl.replace(/\/+$/, "")}/free-tier/v1`,
    wire_api: "chatcompletions",
    name: config.provider.name,
    models,
  };
}

export type ApplyFreeTierProviderOptions = {
  config: FreeTierConfig;
  loopbackBaseUrl: string;
  enabled: boolean;
};

export type ApplyFreeTierProviderResult = {
  changed: boolean;
  enabled: boolean;
  providerId: string;
};

/**
 * Upsert or remove the provider record. Idempotent: an unchanged record writes
 * nothing, so a repeated toggle does not churn the file the picker reads.
 */
export async function applyFreeTierProvider(
  options: ApplyFreeTierProviderOptions,
): Promise<ApplyFreeTierProviderResult> {
  const providerId = options.config.provider.id;
  const file = await readCodexProviders();
  const before = JSON.stringify(file.providers);

  if (options.enabled) {
    file.providers[providerId] = freeTierProviderRecord(options.config, options.loopbackBaseUrl);
    await setCodexAuthKey(providerId, codexEnvKeyForProvider(providerId), FREE_TIER_PLACEHOLDER_KEY);
  } else {
    delete file.providers[providerId];
    await removeCodexAuthKey(codexEnvKeyForProvider(providerId));
  }

  const changed = JSON.stringify(file.providers) !== before;
  if (changed) await writeCodexProviders(file);
  return { changed, enabled: options.enabled, providerId };
}

/** True when the engine catalog already carries the provider. */
export async function isFreeTierProviderRegistered(providerId: string): Promise<boolean> {
  const file = await readCodexProviders();
  return Object.prototype.hasOwnProperty.call(file.providers, providerId);
}

/**
 * `SOFIA_FREE_TIER_ENABLED=0` force-removes the provider on boot. Absent, the
 * boot pass preserves the user's choice: it refreshes an existing registration
 * (the gateway URL embeds the port) and never opts a user in on its own.
 */
export function freeTierDisabledByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.SOFIA_FREE_TIER_ENABLED;
  if (raw === undefined) return false;
  return raw === "0" || raw.toLowerCase() === "false";
}
