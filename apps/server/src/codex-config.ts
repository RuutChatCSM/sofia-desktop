// Maps the engine runtime provider map (the same data the UI model picker
// uses) to a codex `config.toml` that the bundled codex engine can consume.
// Additive — engine provider storage is untouched.
import {
  ENGINE_FEATURES,
  resolveEngineFeatureEnabled,
  type EngineFeatureOverrides,
} from "./engine-features.js";
import type { RuntimeWorkspaceEngineConfig } from "./runtime-engine-config-store.js";

export type CodexWireApi = "responses" | "chatcompletions" | "anthropic";

export function codexWireApiForProvider(
  providerId: string,
  value: Record<string, unknown>,
): CodexWireApi {
  const options = isRecord(value.options) ? value.options : null;
  const explicit = readRequiredString(value.wireApi)
    ?? readRequiredString(value.wire_api)
    ?? (options ? readRequiredString(options.wireApi) : null)
    ?? (options ? readRequiredString(options.wire_api) : null);
  if (explicit === "responses" || explicit === "chatcompletions" || explicit === "anthropic") return explicit;

  const npm = (readRequiredString(value.npm) ?? (options ? readRequiredString(options.npm) : null))?.toLowerCase() ?? "";
  const id = providerId.trim().toLowerCase();
  const officialOpenAiSdk = npm.includes("@ai-sdk/openai") && !npm.includes("openai-compatible");
  if (id === "openai" || officialOpenAiSdk) return "responses";
  if (id === "anthropic" || npm === "@ai-sdk/anthropic") return "anthropic";
  return "chatcompletions";
}

/**
 * Translate an engine provider entry into the subset of a codex
 * `[model_providers.NAME]` table codex needs. Returns null when the provider
 * cannot be represented (no base_url and no api) or is explicitly skipped.
 */
export function mapWorkspaceEngineProviderToCodex(
  providerId: string,
  value: Record<string, unknown>,
): { name: string; baseUrl: string; envKey: string | null; wireApi: CodexWireApi } | null {
  if (!isRecord(value)) return null;

  const options = isRecord(value.options) ? value.options : null;
  const rawBaseUrl =
    (options && readRequiredString(options.baseURL)) ||
    (options && readRequiredString(options.baseUrl)) ||
    readRequiredString(value.api);
  if (!rawBaseUrl) return null;

  const baseUrl = rawBaseUrl.replace(/\/api\/v1\/?$/, "");
  const envKey = firstString(Array.isArray(value.env) ? value.env : null) ?? null;
  const name = readRequiredString(value.name) ?? providerId;

  return { name, baseUrl, envKey, wireApi: codexWireApiForProvider(providerId, value) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRequiredString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function firstString(value: unknown[] | null): string | null {
  if (!value) return null;
  for (const entry of value) {
    const item = typeof entry === "string" && entry.trim() ? entry.trim() : null;
    if (item) return item;
  }
  return null;
}

/** Emit a codex `config.toml` body from the engine runtime provider map. */
export function buildCodexConfigToml(
  providerMap: Record<string, Record<string, unknown>>,
): string {
  const sections: string[] = [];

  for (const [providerId, value] of Object.entries(providerMap)) {
    const mapped = mapWorkspaceEngineProviderToCodex(providerId, value);
    if (!mapped) continue;

    const lines = [`[model_providers.${tomlKey(providerId)}]`, `name = ${tomlString(mapped.name)}`];
    lines.push(`base_url = ${tomlString(mapped.baseUrl)}`);
    lines.push(`wire_api = ${tomlString(mapped.wireApi)}`);
    if (mapped.envKey) lines.push(`env_key = ${tomlString(mapped.envKey)}`);
    sections.push(lines.join("\n"));
  }

  return sections.length ? `${sections.join("\n\n")}\n` : "";
}

/** Pick a codex provider id + model to default to, if one is present. */
export function pickDefaultCodexProvider(
  providerMap: Record<string, Record<string, unknown>>,
): { providerId: string; model: string | null } | null {
  for (const [providerId, value] of Object.entries(providerMap)) {
    if (!mapWorkspaceEngineProviderToCodex(providerId, value)) continue;
    const models = isRecord(value.models) ? Object.keys(value.models) : [];
    return { providerId, model: models[0] ?? null };
  }
  return null;
}

export function addCodexDefaultProviderLines(
  body: string,
  providerMap: Record<string, Record<string, unknown>>,
): string {
  const pick = pickDefaultCodexProvider(providerMap);
  if (!pick) return body;
  const lines = [`model_provider = ${tomlString(pick.providerId)}`];
  if (pick.model) lines.push(`model = ${tomlString(pick.model)}`);
  const rest = body.trim();
  return rest ? `${lines.join("\n")}\n${rest}` : `${lines.join("\n")}\n`;
}

/** Serialize a config.toml from the full runtime config's provider map. */
export function codexConfigTomlFromRuntime(
  config: RuntimeWorkspaceEngineConfig,
): string {
  const providerMap = isRecord(config.provider) ? config.provider as Record<string, Record<string, unknown>> : {};
  const body = buildCodexConfigToml(providerMap);
  return addCodexDefaultProviderLines(body, providerMap);
}

function tomlKey(value: string): string {
  // Codex keys accept [A-Za-z0-9._-]; keep ids that are safe verbatim.
  return /^[A-Za-z0-9_.-]+$/.test(value) ? value : JSON.stringify(value);
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

/**
 * Apply the engine feature flags the user has chosen.
 *
 * Merges per table rather than appending: a config that already carries
 * `[features]` (for example `direct_only_tool_namespaces`) would fail to parse
 * with a second `[features]` header, and the engine runs `--strict-config`, so a
 * duplicate header is a start failure rather than a warning.
 *
 * Removed-stage flags are never emitted even if a stale override says otherwise.
 */
export function applyEngineCapabilitiesToml(
  toml: string,
  overrides?: EngineFeatureOverrides | null,
): string {
  let next = toml;
  const features: string[] = [];
  for (const feature of ENGINE_FEATURES) {
    if (feature.stage === "removed") continue;
    if (!resolveEngineFeatureEnabled(feature.key, overrides)) continue;
    if (feature.kind === "tool") {
      next = upsertTopLevelBool(next, `tools.${feature.key}`, "enabled", true);
      continue;
    }
    features.push(`${feature.key} = true`);
  }
  if (features.length > 0) {
    next = upsertTopLevelKeys(next, "features", features);
  }
  return next;
}

/** Set `key = true` inside `[table]`, creating the table or key when missing. */
export function upsertTopLevelKeys(toml: string, table: string, assignments: string[]): string {
  const keys = assignments.map((assignment) => assignment.split(" = ")[0] ?? "");
  const header = `[${table}]`;
  const lines = toml.split("\n");

  const headerIndex = lines.findIndex((line) => line.trim() === header);
  if (headerIndex === -1) {
    return `${toml.trim() ? `${toml.trimEnd()}\n\n` : ""}${header}\n${assignments.join("\n")}\n`;
  }

  // Walk this table's body, bounded by the next header.
  let bodyEnd = lines.length;
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    if (lines[index].trimStart().startsWith("[")) {
      bodyEnd = index;
      break;
    }
  }
  const missing: string[] = [];
  for (const [index, assignment] of assignments.entries()) {
    const key = keys[index] ?? "";
    // Set an existing key in place; otherwise append and keep scanning.
    let found = false;
    for (let scan = headerIndex + 1; scan < bodyEnd; scan += 1) {
      const keyMatch = /^\s*([A-Za-z0-9_.-]+)\s*=/.exec(lines[scan] ?? "");
      if (keyMatch?.[1] === key) {
        lines[scan] = assignment;
        found = true;
        break;
      }
    }
    if (!found) missing.push(assignment);
  }
  if (missing.length > 0) lines.splice(bodyEnd, 0, ...missing);
  return lines.join("\n");
}

/** Set `table.key = value`, creating the table or the key when missing. */
function upsertTopLevelBool(toml: string, table: string, key: string, value: boolean): string {
  return upsertTopLevelKeys(toml, table, [`${key} = ${value}`]);
}
