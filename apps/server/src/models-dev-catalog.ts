// The models.dev provider catalog: every provider a user can connect, with the
// models it serves.
//
// The static well-known list in `provider-catalog.ts` is only the engine's
// *env-var discovery* set (14 providers the engine registers when a matching
// env var is set). The full catalog is models.dev, which the CLI's `/connect`
// already uses and which carries ~190 providers plus their model lists. The app
// must read the same catalog, or the connect modal offers a small fraction of
// what the CLI offers.
//
// Served by the Sofia inference app (a curated, self-hostable mirror of
// models.dev) with the upstream models.dev as a fallback, and cached in-process
// so a connect does not re-fetch per request.
import { readFile } from "node:fs/promises";

import { externalFetch } from "./server-fetch.js";

const MODELS_DEV_URLS = [
  "https://sofia-models.ruut.chat/api.json",
  "https://models.dev/api.json",
] as const;

const CATALOG_TTL_MS = 10 * 60 * 1000;
const CATALOG_FETCH_TIMEOUT_MS = 15_000;

export type CatalogModel = {
  id: string;
  name: string;
  /** models.dev `reasoning` — drives the effort picker. */
  reasoning: boolean;
  /** models.dev `limit.context`, for engine auto-compaction. */
  contextWindow: number | null;
};

export type CatalogEntry = {
  id: string;
  name: string;
  /** Every env var the catalog lists for this provider, most specific first. */
  envKeys: string[];
  /** The provider's OpenAI-compatible base URL, when the catalog publishes one. */
  baseUrl: string | null;
  doc: string | null;
  models: CatalogModel[];
};

type Cache = { expiresAt: number; entries: CatalogEntry[]; byId: Map<string, CatalogEntry> };

let cache: Cache | null = null;
let inFlight: Promise<Cache> | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asPositiveInt(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

/**
 * Non-chat endpoints multi-modal providers advertise on `/models` (ASR, TTS,
 * embeddings, moderation). They cannot be prompted and must not reach the picker.
 */
const NON_CHAT_MODEL = /(^|[-_/])(asr|tts|whisper|embed|embedding|rerank|voiceclone|voicedesign|moderation|image|guard)([-_/]|$)/i;

function isChatModelId(id: string): boolean {
  return id.trim().length > 0 && !NON_CHAT_MODEL.test(id);
}

/**
 * Parse a models.dev `api.json` payload into catalog entries.
 *
 * A provider is connectable only when it advertises a credential (`env`) — the
 * app has nothing to store otherwise. Providers with no `api` base URL are kept
 * when they are locally hosted, and skipped otherwise, because the engine has
 * no endpoint to call.
 */
export function parseModelsDevCatalog(payload: unknown): CatalogEntry[] {
  if (!isRecord(payload)) return [];
  const entries: CatalogEntry[] = [];
  for (const [providerKey, rawProvider] of Object.entries(payload)) {
    if (!isRecord(rawProvider)) continue;
    const id = asString(rawProvider.id) ?? providerKey;
    const name = asString(rawProvider.name) ?? id;
    const envKeys = Array.isArray(rawProvider.env)
      ? rawProvider.env.filter((value): value is string => typeof value === "string" && !!value.trim()).map((value) => value.trim())
      : [];
    if (envKeys.length === 0) continue;
    const baseUrl = asString(rawProvider.api);
    if (!baseUrl) continue;

    const modelsRecord = isRecord(rawProvider.models) ? rawProvider.models : {};
    const models: CatalogModel[] = [];
    for (const [modelKey, rawModel] of Object.entries(modelsRecord)) {
      const modelId = isRecord(rawModel) ? asString(rawModel.id) ?? modelKey : modelKey;
      if (!isChatModelId(modelId)) continue;
      const limit = isRecord(rawModel) ? rawModel.limit : undefined;
      models.push({
        id: modelId,
        name: (isRecord(rawModel) ? asString(rawModel.name) : null) ?? modelId,
        reasoning: isRecord(rawModel) && rawModel.reasoning === true,
        contextWindow: isRecord(limit) ? asPositiveInt(limit.context) : null,
      });
    }
    models.sort((left, right) => left.name.localeCompare(right.name));

    entries.push({ id, name, envKeys, baseUrl, doc: asString(rawProvider.doc), models });
  }
  // Stable display order, matching the CLI's name-sorted catalog.
  entries.sort((left, right) => left.name.localeCompare(right.name));
  return entries;
}

async function fetchCatalogJson(): Promise<unknown> {
  for (const url of MODELS_DEV_URLS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CATALOG_FETCH_TIMEOUT_MS);
    try {
      const response = await externalFetch(url, {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) continue;
      const parsed = parseModelsDevCatalog(await response.json());
      if (parsed.length > 0) return parsed;
    } catch {
      // Try the next mirror.
    } finally {
      clearTimeout(timer);
    }
  }
  return [];
}

async function loadCatalog(opts?: { fetchImpl?: typeof fetch }): Promise<Cache> {
  if (cache && cache.expiresAt > Date.now()) return cache;
  if (inFlight) return inFlight;

  const run = (async (): Promise<Cache> => {
    let entries: CatalogEntry[] = [];
    if (opts?.fetchImpl) {
      const response = await opts.fetchImpl(MODELS_DEV_URLS[0], { headers: { Accept: "application/json" } });
      if (response.ok) entries = parseModelsDevCatalog(await response.json());
    } else {
      entries = (await fetchCatalogJson()) as CatalogEntry[];
    }
    const next: Cache = {
      // An empty result is not cached, so a transient outage does not pin the
      // app to an empty provider list for the whole TTL.
      expiresAt: entries.length > 0 ? Date.now() + CATALOG_TTL_MS : 0,
      entries,
      byId: new Map(entries.map((entry) => [entry.id, entry])),
    };
    if (entries.length > 0) cache = next;
    return next;
  })();

  inFlight = run;
  const settled = run.finally(() => {
    if (inFlight === run) inFlight = null;
  });
  return settled;
}

/**
 * Every connectable provider from the catalog. Falls back to an empty list when
 * the catalog is unreachable; callers layer the static well-known list on top so
 * the connect modal is never empty.
 */
export async function listCatalogProviders(opts?: { fetchImpl?: typeof fetch }): Promise<CatalogEntry[]> {
  return (await loadCatalog(opts)).entries;
}

export async function getCatalogProvider(
  providerId: string,
  opts?: { fetchImpl?: typeof fetch },
): Promise<CatalogEntry | null> {
  const wanted = providerId.trim().toLowerCase();
  if (!wanted) return null;
  const found = (await loadCatalog(opts)).byId.get(wanted);
  if (found) return found;
  // Providers are also reachable by any of their env var names.
  return (await loadCatalog(opts)).entries.find((entry) =>
    entry.envKeys.some((envKey) => envKey.toLowerCase() === wanted),
  ) ?? null;
}

/** Clear the in-process cache (tests, and manual refresh). */
export function resetModelsDevCatalogCache(): void {
  cache = null;
  inFlight = null;
}

/** Read the curated catalog snapshot shipped in-repo (offline/dev fallback). */
export async function readCuratedCatalogFile(path: string): Promise<CatalogEntry[]> {
  try {
    return parseModelsDevCatalog(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return [];
  }
}
