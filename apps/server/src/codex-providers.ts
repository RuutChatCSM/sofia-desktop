// providers.json — the codex-native provider catalog for the bundled Sofia
// (codex fork) engine. Mirrors exactly what the codex TUI's `/connect` flow
// persists (codex-rs/tui/src/chatwidget/connect_provider_popup.rs):
//
//   { "providers": { "<id>": {
//       "api_key": "sk-...", "base_url": "https://...", "wire_api": "chat_completions",
//       "name": "DeepSeek",
//       "models": [ { "id": "...", "name": "...", "reasoning": true } ] } } }
//
// The engine resolves provider credentials from `sofia-auth.json` (flat
// `envKey -> key`), where envKey is codex's derived rule `<ID>_API_KEY`
// (uppercased, `-` -> `_`) — the same name emitted as `env_key` in config.toml.
// The app-facing model picker still consumes the flattened `CodexEngineConfig`.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { type CodexWireApi } from "./codex-config.js";
import { readCodexAuthStore } from "./codex-auth-store.js";

export type CodexProviderModel = {
  id: string;
  name: string;
  reasoning: boolean;
  /** Context window in tokens (models.dev `limit.context`), for auto-compaction. */
  contextWindow?: number | null;
};

/** On-disk record codex writes per provider in providers.json. */
export type CodexProviderRecord = {
  api_key: string;
  base_url: string;
  wire_api: string;
  name: string;
  models: CodexProviderModel[];
};

export type CodexProvidersFile = { providers: Record<string, CodexProviderRecord> };

/** App-facing provider shape consumed by the model picker. */
export type CodexProviderConfig = {
  providerId: string;
  providerName: string;
  baseUrl: string | null;
  envKey: string | null;
  wireApi: CodexWireApi;
  models: CodexProviderModel[];
};

export type CodexEngineConfig = {
  /** The default provider to use for new threads. */
  defaultProviderId: string | null;
  /** The default model id within the default provider. */
  model: string | null;
  providers: CodexProviderConfig[];
};

export const CODEX_PROVIDERS_FILE = "providers.json";
export const CODEX_CONFIG_TOML_FILE = "config.toml";

/** codex's env-key derivation: `<ID>_API_KEY` (uppercased, `-` -> `_`). */
export function codexEnvKeyForProvider(providerId: string): string {
  return `${providerId.toUpperCase().replace(/-/g, "_")}_API_KEY`;
}

/**
 * Resolve the codex engine home. Kept in lockstep with `codexHomeFor`
 * (codex-registry.ts) and `codexAuthStorePath` (codex-auth-store.ts) so
 * providers.json, config.toml and sofia-auth.json live in the same directory
 * the engine reads ($CODEX_HOME).
 */
export function codexHomeDir(opts?: { env?: NodeJS.ProcessEnv }): string {
  const env = opts?.env ?? process.env;
  const pinned = env.OPENWORK_CODEX_HOME?.trim() || env.CODEX_HOME?.trim();
  if (pinned) return pinned;
  const home = env.HOME?.trim() || homedir();
  return join(home, ".sofia");
}

export function codexProvidersPath(opts?: { env?: NodeJS.ProcessEnv }): string {
  return join((opts?.env ?? process.env).SOFIA_PROVIDER_HOME?.trim() || codexHomeDir(opts), CODEX_PROVIDERS_FILE);
}

export function codexConfigTomlPath(opts?: { env?: NodeJS.ProcessEnv }): string {
  return join((opts?.env ?? process.env).SOFIA_PROVIDER_HOME?.trim() || codexHomeDir(opts), CODEX_CONFIG_TOML_FILE);
}

export async function readCodexProviders(
  opts?: { path?: string; env?: NodeJS.ProcessEnv },
): Promise<CodexProvidersFile> {
  const filePath = opts?.path ?? codexProvidersPath({ env: opts?.env });
  try {
    return normalizeProvidersFile(JSON.parse(await readFile(filePath, "utf8")));
  } catch {
    return { providers: {} };
  }
}

export async function writeCodexProviders(
  file: CodexProvidersFile,
  opts?: { path?: string; env?: NodeJS.ProcessEnv },
): Promise<string> {
  const filePath = opts?.path ?? codexProvidersPath({ env: opts?.env });
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(providersFileForDisk(file), null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return filePath;
}

/**
 * Flatten providers.json (catalog) + config.toml (top-level selection) into the
 * app-facing config the model picker consumes. Falls back to the first provider/
 * model when no valid selection is present.
 */
export async function readCodexEngineConfig(
  opts?: { path?: string; env?: NodeJS.ProcessEnv; tomlPath?: string },
): Promise<CodexEngineConfig> {
  const file = await readCodexProviders({ path: opts?.path, env: opts?.env });
  const providers: CodexProviderConfig[] = Object.entries(file.providers).map(([providerId, record]) => ({
    providerId,
    providerName: record.name,
    baseUrl: record.base_url,
    envKey: codexEnvKeyForProvider(providerId),
    wireApi: record.wire_api === "responses" ? "responses" : "chatcompletions",
    models: record.models,
  }));

  const toml = await readConfigToml(opts);
  const selectedProvider = readTomlTopLevelString(toml, "model_provider");
  const defaultProviderId = selectedProvider && providers.some((p) => p.providerId === selectedProvider)
    ? selectedProvider
    : providers[0]?.providerId ?? null;
  const defaultProvider = providers.find((p) => p.providerId === defaultProviderId) ?? null;
  const selectedModel = readTomlTopLevelString(toml, "model");
  const model = selectedModel && defaultProvider?.models.some((m) => m.id === selectedModel)
    ? selectedModel
    : defaultProvider?.models[0]?.id ?? null;

  return { defaultProviderId, model, providers };
}

/** Parse and validate an arbitrary value into a `CodexEngineConfig` (route payload). */
export function parseCodexEngineConfig(value: unknown): CodexEngineConfig {
  return normalizeCodexEngineConfig(value);
}

/**
 * Merge an explicit provider list (the app's connected providers, which already
 * carry models.dev-backed models) into the codex-native providers.json. On-disk
 * providers absent from the list are preserved; selection stays in config.toml.
 */
export async function writeCodexEngineConfigFromProviders(
  providers: CodexProviderConfig[],
  opts?: { path?: string; env?: NodeJS.ProcessEnv },
): Promise<string> {
  const authStore = await readCodexAuthStore({ env: opts?.env });
  const existing = await readCodexProviders({ path: opts?.path, env: opts?.env });
  // Start from what is already on disk: the app push only knows the providers
  // its own auth store exposes, so a CLI-connected provider (e.g. one the app
  // cannot see) must survive the sync instead of being dropped.
  const records: Record<string, CodexProviderRecord> = { ...existing.providers };
  for (const provider of providers) {
    const envKey = codexEnvKeyForProvider(provider.providerId);
    const prior = existing.providers[provider.providerId];
    records[provider.providerId] = {
      // Never let an unresolved value clobber a previously good one — an empty
      // base_url strands the engine (requests never reach the provider).
      api_key: authStore[envKey] ?? prior?.api_key ?? "",
      base_url: provider.baseUrl ?? prior?.base_url ?? "",
      wire_api: provider.wireApi,
      name: provider.providerName,
      models: provider.models.length > 0 ? provider.models : prior?.models ?? [],
    };
  }
  return writeCodexProviders({ providers: records }, opts);
}

/**
 * Serialize a codex `config.toml` body from the flattened engine config.
 * `env_key` is codex's derived `<ID>_API_KEY`, matching sofia-auth.json.
 */
export function codexConfigTomlFromEngineConfig(config: CodexEngineConfig): string {
  const sections: string[] = [];
  for (const provider of config.providers) {
    const lines = [`[model_providers.${tomlKey(provider.providerId)}]`];
    lines.push(`name = ${tomlString(provider.providerName)}`);
    if (provider.baseUrl) lines.push(`base_url = ${tomlString(provider.baseUrl)}`);
    lines.push(`wire_api = ${tomlString(provider.wireApi)}`);
    lines.push(`env_key = ${tomlString(codexEnvKeyForProvider(provider.providerId))}`);
    sections.push(lines.join("\n"));
  }
  if (!sections.length) return "";
  const body = sections.join("\n\n");
  const defaultLines = [`model_provider = ${tomlString(config.defaultProviderId ?? "")}`];
  if (config.model) defaultLines.push(`model = ${tomlString(config.model)}`);
  // Size auto-compaction from the selected model's window (models.dev
  // `limit.context`). Without it the engine has no window for chat-completions
  // models and never compacts, growing until the provider rejects the request.
  const selectedModel = config.providers
    .find((provider) => provider.providerId === config.defaultProviderId)
    ?.models.find((model) => model.id === config.model);
  if (selectedModel?.contextWindow) {
    defaultLines.push(`model_context_window = ${selectedModel.contextWindow}`);
  }
  return `${defaultLines.join("\n")}\n${body}\n`;
}

async function readConfigToml(opts?: { env?: NodeJS.ProcessEnv; tomlPath?: string }): Promise<string> {
  const filePath = opts?.tomlPath ?? codexConfigTomlPath({ env: opts?.env });
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

/**
 * Read a top-level string scalar from a config.toml we author. Top-level keys
 * are emitted before the first `[table]`, so only that prefix is scanned.
 */
function readTomlTopLevelString(toml: string, key: string): string | null {
  const untilTable = toml.split(/^\[/m)[0] ?? "";
  const match = new RegExp(`^\\s*${key}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"`, "m").exec(untilTable);
  if (!match) return null;
  try {
    return JSON.parse(`"${match[1]}"`);
  } catch {
    return null;
  }
}

function normalizeProvidersFile(value: unknown): CodexProvidersFile {
  const source = isRecord(value) ? value : {};
  const raw = isRecord(source.providers) ? source.providers : {};
  const providers: Record<string, CodexProviderRecord> = {};
  for (const [providerId, entry] of Object.entries(raw)) {
    if (!providerId.trim() || !isRecord(entry)) continue;
    providers[providerId] = {
      api_key: typeof entry.api_key === "string" ? entry.api_key : "",
      base_url: typeof entry.base_url === "string" ? entry.base_url : "",
      wire_api: typeof entry.wire_api === "string" ? entry.wire_api : "chatcompletions",
      name: typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : providerId,
      models: normalizeProviderModels(entry.models),
    };
  }
  return { providers };
}

function normalizeCodexEngineConfig(value: unknown): CodexEngineConfig {
  const source = isRecord(value) ? value : {};
  const str = (key: string): string | null => {
    const v = source[key];
    return typeof v === "string" && v.trim() ? v.trim() : null;
  };
  const rawProviders = Array.isArray(source.providers) ? source.providers : [];
  const providers: CodexProviderConfig[] = [];
  for (const entry of rawProviders) {
    const record = isRecord(entry) ? entry : null;
    const providerId = record && typeof record.providerId === "string" && record.providerId.trim()
      ? record.providerId.trim()
      : null;
    if (!providerId) continue;
    const rawWireApi = record && typeof record.wireApi === "string" ? record.wireApi : null;
    const wireApi: CodexWireApi = rawWireApi === "responses" || rawWireApi === "chatcompletions"
      ? rawWireApi
      : providerId.toLowerCase() === "openai" ? "responses" : "chatcompletions";
    providers.push({
      providerId,
      providerName: record && typeof record.providerName === "string" && record.providerName.trim()
        ? record.providerName.trim()
        : providerId,
      baseUrl: record && typeof record.baseUrl === "string" && record.baseUrl.trim() ? record.baseUrl.trim() : null,
      envKey: record && typeof record.envKey === "string" && record.envKey.trim() ? record.envKey.trim() : null,
      wireApi,
      models: normalizeProviderModels(record?.models),
    });
  }
  const defaultProviderId = str("defaultProviderId") ?? (providers[0]?.providerId ?? null);
  return { defaultProviderId, model: str("model"), providers };
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
      contextWindow: normalizeContextWindow(record?.contextWindow ?? record?.context_window),
    });
  }
  return models;
}

function normalizeContextWindow(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

/// Serialize a provider model to codex's on-disk snake_case shape, including
/// the context window so the engine can size auto-compaction.
function recordModelForDisk(model: CodexProviderModel): Record<string, unknown> {
  const entry: Record<string, unknown> = { id: model.id, name: model.name, reasoning: model.reasoning };
  if (typeof model.contextWindow === "number") entry.context_window = model.contextWindow;
  return entry;
}

function providersFileForDisk(file: CodexProvidersFile): Record<string, unknown> {
  const providers: Record<string, unknown> = {};
  for (const [providerId, record] of Object.entries(file.providers)) {
    providers[providerId] = {
      api_key: record.api_key,
      base_url: record.base_url,
      wire_api: record.wire_api,
      name: record.name,
      models: record.models.map(recordModelForDisk),
    };
  }
  return { providers };
}

function tomlKey(value: string): string {
  return /^[A-Za-z0-9_.-]+$/.test(value) ? value : JSON.stringify(value);
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}
