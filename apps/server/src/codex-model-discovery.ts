// Model-catalog discovery for the bundled Sofia (codex) engine.
//
// A provider written by the CLI's `/connect` flow carries only the models the
// live `/models` endpoint (merged with the models.dev catalog) returned at
// connect time. Multi-modal OpenAI-compatible providers sometimes answer
// `/models` with a schema the CLI drops, leaving `models: []` on disk — the
// provider then exists in providers.json but is invisible in the app's model
// picker, which renders providers through their models.
//
// This module resolves those empty catalogs from the provider itself, so a
// provider connected in the CLI shows up in the app without reconnecting.
import { readCodexAuthStore } from "./codex-auth-store.js";
import {
  codexEnvKeyForProvider,
  codexProvidersPath,
  readCodexProviders,
  writeCodexProviders,
  type CodexProviderModel,
  type CodexProvidersFile,
} from "./codex-providers.js";

const DISCOVERY_TIMEOUT_MS = 8_000;
/** Back off after a failed lookup so a provider without `/models` is not
 * probed on every config read. */
const RETRY_AFTER_MS = 60_000;

/**
 * Non-chat endpoints advertised by multi-modal OpenAI-compatible providers.
 * MiMo, for example, returns `mimo-v2.5-asr`/`-tts`/`-voiceclone` on `/models`;
 * they cannot be prompted and must not reach the model picker.
 */
const NON_CHAT_MODEL = /(^|[-_/])(asr|tts|whisper|embed|embedding|rerank|voiceclone|voicedesign|moderation|image|guard)([-_/]|$)/i;

type FetchLike = typeof fetch;

const lastFailureAt = new Map<string, number>();
const inFlight = new Map<string, Promise<CodexProvidersFile>>();

export function isChatModelId(id: string): boolean {
  return id.trim().length > 0 && !NON_CHAT_MODEL.test(id);
}

/**
 * Resolve and persist model catalogs for providers whose on-disk catalog is
 * empty. Never throws: a provider that cannot be reached keeps its existing
 * (possibly empty) catalog and is retried later.
 */
export async function discoverProviderModels(opts?: {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  now?: () => number;
}): Promise<CodexProvidersFile> {
  const env = opts?.env ?? process.env;
  const now = opts?.now ?? Date.now;
  const timeoutMs = opts?.timeoutMs ?? DISCOVERY_TIMEOUT_MS;
  const file = await readCodexProviders({ env });
  const auth = await readCodexAuthStore({ env });

  let changed = false;
  await Promise.all(
    Object.entries(file.providers).map(async ([providerId, record]) => {
      if (record.models.length > 0) return;
      const baseUrl = record.base_url?.trim();
      if (!baseUrl) return;
      const cacheKey = `${providerId}@${baseUrl}`;
      const failedAt = lastFailureAt.get(cacheKey);
      if (failedAt !== undefined && now() - failedAt < RETRY_AFTER_MS) return;

      const apiKey = record.api_key?.trim() || auth[codexEnvKeyForProvider(providerId)]?.trim() || "";
      const models = await fetchProviderModels({ baseUrl, apiKey, fetchImpl: opts?.fetchImpl, timeoutMs });
      if (models.length === 0) {
        lastFailureAt.set(cacheKey, now());
        return;
      }
      lastFailureAt.delete(cacheKey);
      record.models = models;
      changed = true;
    }),
  );

  if (!changed) return file;
  await writeCodexProviders(file, { env });
  return file;
}

/** De-duplicate concurrent discovery runs for the same engine home. */
export function ensureProviderModels(opts?: {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}): Promise<CodexProvidersFile> {
  const key = codexProvidersPath({ env: opts?.env });
  const running = inFlight.get(key);
  if (running) return running;
  const run = discoverProviderModels(opts);
  inFlight.set(key, run);
  const settled = run.finally(() => {
    if (inFlight.get(key) === run) inFlight.delete(key);
  });
  return settled;
}

/** Clear the in-process negative cache (used by tests). */
export function resetProviderModelDiscoveryCache(): void {
  lastFailureAt.clear();
  inFlight.clear();
}

async function fetchProviderModels(input: {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: FetchLike;
  timeoutMs: number;
}): Promise<CodexProviderModel[]> {
  const url = `${input.baseUrl.replace(/\/+$/, "")}/models`;
  const doFetch = input.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const response = await doFetch(url, {
      method: "GET",
      headers: input.apiKey ? { Authorization: `Bearer ${input.apiKey}` } : {},
      signal: controller.signal,
    });
    if (!response.ok) return [];
    return parseModelsPayload(await response.json());
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** Accept both the OpenAI `{ data: [...] }` envelope and a bare array. */
export function parseModelsPayload(payload: unknown): CodexProviderModel[] {
  const entries = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.data)
      ? payload.data
      : isRecord(payload) && Array.isArray(payload.models)
        ? payload.models
        : [];
  const models: CodexProviderModel[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const id = readModelId(entry);
    if (!id || seen.has(id) || !isChatModelId(id)) continue;
    seen.add(id);
    models.push({ id, name: readModelName(entry) ?? id, reasoning: true });
  }
  return models;
}

function readModelId(entry: unknown): string | null {
  if (typeof entry === "string") return entry.trim() || null;
  if (!isRecord(entry)) return null;
  for (const key of ["id", "model", "name"]) {
    const value = entry[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function readModelName(entry: unknown): string | null {
  if (!isRecord(entry)) return null;
  for (const key of ["display_name", "displayName", "name"]) {
    const value = entry[key];
    if (typeof value === "string" && value.trim() && value.trim() !== readModelId(entry)) return value.trim();
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
