// codexengine.json — OpenWork's own codex engine config file, stored in the
// global user config dir. The app's model configuration (provider + model
// pickers) writes it; the bundled codex engine reads it at spawn to know which
// providers/models to expose. Supports any number of providers (not just one),
// each mapped into a `[model_providers.*]` table in the generated config.toml.
// API keys live separately in sofia-auth.json (flat envKey -> key).
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { openworkConfigDir } from "@openwork/paths";
import { codexWireApiForProvider, type CodexWireApi } from "./codex-config.js";

export type CodexProviderModel = {
  id: string;
  name: string;
  reasoning: boolean;
};

export type CodexProviderConfig = {
  providerId: string;
  providerName: string;
  baseUrl: string | null;
  envKey: string | null;
  wireApi: CodexWireApi;
  /** Models the provider exposes, so the codex engine's picker is engine-native. */
  models: CodexProviderModel[];
};

export type CodexEngineConfig = {
  /** The default provider to use for new threads. */
  defaultProviderId: string | null;
  /** The default model id within the default provider. */
  model: string | null;
  providers: CodexProviderConfig[];
};

export const CODEX_ENGINE_CONFIG_FILE = "codexengine.json";

// The codex engine home is pinned by the desktop (OPENWORK_CODEX_HOME) to a
// real-home path so dev and packaged builds share one source of truth. Keep
// the provider-map config in that same home — otherwise dev (sandbox HOME)
// and prod read different codexengine.json files and the model config is empty.
export function codexEngineConfigPath(opts?: { env?: NodeJS.ProcessEnv }): string {
  const env = opts?.env ?? process.env;
  const pinnedHome = env.OPENWORK_CODEX_HOME?.trim();
  if (pinnedHome) return join(pinnedHome, CODEX_ENGINE_CONFIG_FILE);
  return join(openworkConfigDir({ env }), CODEX_ENGINE_CONFIG_FILE);
}

export const EMPTY_CODEX_ENGINE_CONFIG: CodexEngineConfig = {
  defaultProviderId: null,
  model: null,
  providers: [],
};

export async function readCodexEngineConfig(opts?: { path?: string; env?: NodeJS.ProcessEnv }): Promise<CodexEngineConfig> {
  const filePath = opts?.path ?? codexEngineConfigPath({ env: opts?.env });
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return normalizeCodexEngineConfig(parsed);
  } catch {
    return { ...EMPTY_CODEX_ENGINE_CONFIG };
  }
}

export async function writeCodexEngineConfig(
  config: CodexEngineConfig,
  opts?: { path?: string; env?: NodeJS.ProcessEnv },
): Promise<string> {
  const filePath = opts?.path ?? codexEngineConfigPath({ env: opts?.env });
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(normalizeCodexEngineConfig(config), null, 2)}\n`, "utf8");
  return filePath;
}

function normalizeCodexEngineConfig(value: unknown): CodexEngineConfig {
  const source = isRecord(value) ? value : {};
  const str = (key: string): string | null => {
    const v = source[key];
    return typeof v === "string" && v.trim() ? v.trim() : null;
  };

  // Backward-compatible: a single-provider config from earlier builds maps to
  // a providers list with one entry.
  const legacyProviderId = str("providerId");
  const legacyProviderName = str("providerName") ?? legacyProviderId;
  const legacyBaseUrl = str("baseUrl");
  const legacyEnvKey = str("envKey");

  const rawProviders = Array.isArray(source.providers) ? source.providers : [];
  const providers: CodexProviderConfig[] = [];
  for (const entry of rawProviders) {
    const record = isRecord(entry) ? entry : null;
    const providerId = record && typeof record.providerId === "string" && record.providerId.trim()
      ? record.providerId.trim()
      : null;
    if (!providerId) continue;
    const baseUrl = record && typeof record.baseUrl === "string" && record.baseUrl.trim()
      ? record.baseUrl.trim()
      : null;
    const envKey = record && typeof record.envKey === "string" && record.envKey.trim()
      ? record.envKey.trim()
      : null;
    const rawWireApi = record && typeof record.wireApi === "string" ? record.wireApi : null;
    const wireApi: CodexWireApi = rawWireApi === "responses" || rawWireApi === "chatcompletions"
      ? rawWireApi
      : providerId.toLowerCase() === "openai" ? "responses" : "chatcompletions";
    const models = normalizeProviderModels(record?.models);
    providers.push({
      providerId,
      providerName: record && typeof record.providerName === "string" && record.providerName.trim()
        ? record.providerName.trim()
        : providerId,
      baseUrl,
      envKey,
      wireApi,
      models,
    });
  }

  if (providers.length === 0 && legacyProviderId) {
    providers.push({
      providerId: legacyProviderId,
      providerName: legacyProviderName ?? legacyProviderId,
      baseUrl: legacyBaseUrl,
      envKey: legacyEnvKey,
      wireApi: legacyProviderId.toLowerCase() === "openai" ? "responses" : "chatcompletions",
      models: [],
    });
  }

  const defaultProviderId = str("defaultProviderId") ?? (providers[0]?.providerId ?? null);
  const model = str("model");

  return { defaultProviderId, model, providers };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeProviderModels(value: unknown): CodexProviderModel[] {
  if (!Array.isArray(value)) return [];
  const models: CodexProviderModel[] = [];
  for (const entry of value) {
    const record = isRecord(entry) ? entry : null;
    const id = record && typeof record.id === "string" && record.id.trim() ? record.id.trim() : null;
    if (!id) continue;
    models.push({
      id,
      name: record && typeof record.name === "string" && record.name.trim() ? record.name.trim() : id,
      reasoning: record ? record.reasoning === true : false,
    });
  }
  return models;
}

/**
 * Serialize a codex `config.toml` body from a codexengine.json config.
 * When `authStore` provides the key for a provider's `envKey`, it is also
 * written as `experimental_bearer_token` so the provider works with binaries
 * that read the key from the config file (the official ChatGPT-app codex) in
 * addition to the fork's sofia-auth.json lookup.
 */
export function codexConfigTomlFromEngineConfig(config: CodexEngineConfig, authStore?: Record<string, string>): string {
  const sections: string[] = [];
  for (const provider of config.providers) {
    const lines = [`[model_providers.${tomlKey(provider.providerId)}]`];
    lines.push(`name = ${tomlString(provider.providerName)}`);
    if (provider.baseUrl) lines.push(`base_url = ${tomlString(provider.baseUrl)}`);
    lines.push(`wire_api = ${tomlString(provider.wireApi)}`);
    if (provider.envKey) lines.push(`env_key = ${tomlString(provider.envKey)}`);
    const bearerKey = provider.envKey && authStore ? authStore[provider.envKey] : null;
    if (bearerKey) lines.push(`experimental_bearer_token = ${tomlString(bearerKey)}`);
    sections.push(lines.join("\n"));
  }
  if (!sections.length) return "";
  const body = sections.join("\n\n");
  const defaultLines = [`model_provider = ${tomlString(config.defaultProviderId ?? "")}`];
  if (config.model) defaultLines.push(`model = ${tomlString(config.model)}`);
  return `${defaultLines.join("\n")}\n${body}\n`;
}

function tomlKey(value: string): string {
  return /^[A-Za-z0-9_.-]+$/.test(value) ? value : JSON.stringify(value);
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

/**
 * Derive a codexengine.json config from an opencode runtime provider map (the
 * app model configuration source). ALL representable providers are carried into
 * the engine config, so any provider the app knows becomes usable by the codex
 * engine — not just the first. Persists to the global config dir.
 */
export async function syncCodexEngineConfigFromProviderMap(
  providerMap: Record<string, Record<string, unknown>>,
  opts?: { path?: string; env?: NodeJS.ProcessEnv },
): Promise<string | null> {
  const providers: CodexProviderConfig[] = [];
  for (const [providerId, value] of Object.entries(providerMap)) {
    if (!isRecord(value)) continue;
    const options = isRecord(value.options) ? value.options : null;
    const rawBaseUrl =
      (options && typeof options.baseURL === "string" ? options.baseURL : null) ||
      (options && typeof options.baseUrl === "string" ? options.baseUrl : null) ||
      (typeof value.api === "string" ? value.api : null);
    if (!rawBaseUrl) continue;
    const envList = Array.isArray(value.env) ? value.env : null;
    const envKey = envList?.find((entry) => typeof entry === "string" && entry.trim()) ?? null;
    const baseUrl = rawBaseUrl.replace(/\/api\/v1\/?$/, "");
    providers.push({
      providerId,
      providerName: typeof value.name === "string" && value.name.trim() ? value.name : providerId,
      baseUrl,
      envKey: typeof envKey === "string" ? envKey : null,
      wireApi: codexWireApiForProvider(providerId, value),
      models: providerModelsFromMapEntry(value),
    });
  }
  if (providers.length === 0) return null;

  const first = providers[0];
  const config: CodexEngineConfig = {
    defaultProviderId: first.providerId,
    model: first.models[0]?.id ?? null,
    providers,
  };
  await writeCodexEngineConfig(config, opts);
  return codexEngineConfigPath(opts);
}

function providerModelsFromMapEntry(value: Record<string, unknown>): CodexProviderModel[] {
  const models = isRecord(value.models) ? value.models : null;
  if (!models) return [];
  const out: CodexProviderModel[] = [];
  for (const [id, entry] of Object.entries(models)) {
    const record = isRecord(entry) ? entry : null;
    out.push({
      id,
      name: record && typeof record.name === "string" && record.name.trim() ? record.name.trim() : id,
      reasoning: record ? record.reasoning === true : false,
    });
  }
  return out;
}
