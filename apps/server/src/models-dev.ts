// models.dev integration — fetches, caches, and queries the canonical model
// catalog. Provides typed interfaces for providers, models, and capabilities
// that the config.toml generation pipeline and UI model picker consume.
//
// Data source: https://models.dev/api.json (or configurable via MODELS_DEV_URL).
// Cache: in-memory with configurable TTL (default 1 hour).
// Fallback: bundled snapshot at build time (future), empty catalog for now.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { externalFetch } from "./server-fetch.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ModelCapability = {
  tool_call: boolean;
  reasoning: boolean;
  attachment: boolean;
  temperature: boolean;
  structured_output?: boolean;
  open_weights?: boolean;
};

export type ModelLimits = {
  context: number;
  input?: number;
  output: number;
};

export type ModelCost = {
  input: number;
  output: number;
  reasoning?: number;
  cache_read?: number;
  cache_write?: number;
  input_audio?: number;
  output_audio?: number;
  context_over_200k?: {
    input: number;
    output: number;
    cache_read?: number;
    cache_write?: number;
  };
};

export type ModelModalities = {
  input: string[];
  output: string[];
};

export type ReasoningOption =
  | { type: "effort"; values: string[] }
  | { type: "toggle" }
  | { type: "budget_tokens"; min: number };

export type ModelsDevModel = {
  id: string;
  name: string;
  description?: string;
  family?: string;
  release_date?: string;
  knowledge?: string;
  last_updated?: string;
  status?: "alpha" | "beta" | "deprecated";
  // Capability flags
  tool_call: boolean;
  reasoning: boolean;
  attachment: boolean;
  temperature: boolean;
  structured_output?: boolean;
  open_weights?: boolean;
  // Reasoning details
  reasoning_options?: ReasoningOption[];
  interleaved?: true | { field: string };
  // Limits and cost
  limit: ModelLimits;
  cost?: ModelCost;
  modalities?: ModelModalities;
  // Provider-specific overrides
  provider?: { npm?: string; api?: string };
  experimental?: Record<string, unknown>;
};

export type ModelsDevProvider = {
  id: string;
  name: string;
  env: string[];
  npm?: string;
  api?: string;
  doc?: string;
  models: Record<string, ModelsDevModel>;
};

export type ModelsDevCatalog = Record<string, ModelsDevProvider>;

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_URL = "https://models.dev/api.json";

let cached: ModelsDevCatalog | null = null;
let cachedAt = 0;
let inflight: Promise<ModelsDevCatalog> | null = null;

function cachePath(): string {
  return join(tmpdir(), "openwork-models-dev-cache.json");
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

async function fetchCatalog(url: string, timeoutMs: number): Promise<ModelsDevCatalog> {
  const res = await externalFetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "User-Agent": "openwork-server/1.0" },
  });
  if (!res.ok) throw new Error(`models.dev fetch failed: ${res.status}`);
  const text = await res.text();
  // Write to disk cache (best-effort)
  writeFile(cachePath(), text, "utf8").catch(() => {});
  return JSON.parse(text) as ModelsDevCatalog;
}

async function readDiskCache(): Promise<ModelsDevCatalog | null> {
  try {
    const text = await readFile(cachePath(), "utf8");
    return JSON.parse(text) as ModelsDevCatalog;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type GetCatalogOptions = {
  url?: string;
  timeoutMs?: number;
  forceRefresh?: boolean;
  env?: NodeJS.ProcessEnv;
};

/**
 * Get the models.dev catalog. Returns cached data if fresh, otherwise fetches.
 * Uses a single inflight promise to prevent thundering herd.
 */
export async function getCatalog(opts?: GetCatalogOptions): Promise<ModelsDevCatalog> {
  const url = opts?.url ?? opts?.env?.MODELS_DEV_URL?.trim() ?? DEFAULT_URL;
  const timeoutMs = opts?.timeoutMs ?? 10_000;
  const ttl = DEFAULT_TTL_MS;
  const now = Date.now();

  // Return memory cache if fresh
  if (!opts?.forceRefresh && cached && now - cachedAt < ttl) return cached;

  // Deduplicate concurrent fetches
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const catalog = await fetchCatalog(url, timeoutMs);
      cached = catalog;
      cachedAt = Date.now();
      return catalog;
    } catch {
      // Fall back to disk cache
      const disk = await readDiskCache();
      if (disk) {
        cached = disk;
        cachedAt = now;
        return disk;
      }
      // Fall back to memory cache even if stale
      if (cached) return cached;
      return {};
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

/**
 * Get a single provider's config by ID.
 */
export async function getProvider(
  providerId: string,
  opts?: GetCatalogOptions,
): Promise<ModelsDevProvider | null> {
  const catalog = await getCatalog(opts);
  return catalog[providerId] ?? null;
}

/**
 * Get a single model from a provider.
 */
export async function getModel(
  providerId: string,
  modelId: string,
  opts?: GetCatalogOptions,
): Promise<ModelsDevModel | null> {
  const provider = await getProvider(providerId, opts);
  return provider?.models[modelId] ?? null;
}

/**
 * List all provider IDs.
 */
export async function listProviderIds(opts?: GetCatalogOptions): Promise<string[]> {
  const catalog = await getCatalog(opts);
  return Object.keys(catalog);
}

/**
 * List all models for a provider, with provider context attached.
 */
export async function listModels(
  providerId: string,
  opts?: GetCatalogOptions,
): Promise<ModelsDevModel[]> {
  const provider = await getProvider(providerId, opts);
  return provider ? Object.values(provider.models) : [];
}

/**
 * Search models across all providers by name or ID substring.
 */
export async function searchModels(
  query: string,
  opts?: GetCatalogOptions,
): Promise<Array<{ provider: string; model: ModelsDevModel }>> {
  const catalog = await getCatalog(opts);
  const q = query.toLowerCase();
  const results: Array<{ provider: string; model: ModelsDevModel }> = [];
  for (const [providerId, provider] of Object.entries(catalog)) {
    for (const model of Object.values(provider.models)) {
      if (
        model.id.toLowerCase().includes(q) ||
        model.name.toLowerCase().includes(q) ||
        model.family?.toLowerCase().includes(q)
      ) {
        results.push({ provider: providerId, model });
      }
    }
  }
  return results;
}

/**
 * Filter models by capability requirements.
 */
export async function filterByCapability(
  requirements: Partial<ModelCapability> & { minContext?: number; maxCostPerMillion?: number },
  opts?: GetCatalogOptions,
): Promise<Array<{ provider: string; model: ModelsDevModel }>> {
  const catalog = await getCatalog(opts);
  const results: Array<{ provider: string; model: ModelsDevModel }> = [];

  for (const [providerId, provider] of Object.entries(catalog)) {
    for (const model of Object.values(provider.models)) {
      if (requirements.tool_call && !model.tool_call) continue;
      if (requirements.reasoning && !model.reasoning) continue;
      if (requirements.attachment && !model.attachment) continue;
      if (requirements.structured_output && !model.structured_output) continue;
      if (requirements.minContext && model.limit.context < requirements.minContext) continue;
      if (
        requirements.maxCostPerMillion &&
        model.cost &&
        model.cost.input > requirements.maxCostPerMillion
      )
        continue;
      results.push({ provider: providerId, model });
    }
  }

  return results;
}

/**
 * Convert a models.dev provider entry into a CodexProviderConfig-compatible
 * shape for config.toml generation. This is the bridge between the catalog
// and the engine's config format.
 */
export function providerToCodexConfig(
  provider: ModelsDevProvider,
): { providerId: string; providerName: string; baseUrl: string | null; envKey: string | null } {
  return {
    providerId: provider.id,
    providerName: provider.name,
    baseUrl: provider.api?.replace(/\/api\/v1\/?$/, "") ?? null,
    envKey: provider.env[0] ?? null,
  };
}

/**
 * Get the recommended wire API for a provider based on its npm package.
 * This is the first step toward adapter-based routing.
 */
export function inferAdapter(provider: ModelsDevProvider): string {
  const npm = provider.npm ?? "";
  if (npm.includes("anthropic")) return "anthropic-messages";
  if (npm.includes("google")) return "google-gemini";
  if (npm.includes("bedrock")) return "bedrock-converse";
  if (npm.includes("openai-compatible") || npm.includes("openrouter")) return "openai-chat";
  if (npm.includes("openai")) return "openai-responses";
  // Default: assume OpenAI-compatible
  return "openai-chat";
}

/**
 * Force-refresh the cache. Useful after config changes or on a schedule.
 */
export async function refresh(opts?: GetCatalogOptions): Promise<ModelsDevCatalog> {
  return getCatalog({ ...opts, forceRefresh: true });
}
