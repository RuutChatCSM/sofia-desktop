/**
 * Server-side copy of the desktop provider wire parsers.
 *
 * Why this exists: the packaged server ships tsc output, so every value import
 * survives into `app.asar`. `@sofia/types` exports raw TypeScript and is a
 * devDependency, so importing its runtime helpers from server code crashes the
 * packaged app with `Cannot find package '@sofia/types'` — and shipping the
 * package would not help either, because Node cannot load `.ts` from the asar.
 * The engine plugins avoid this by being bundled with `bun build`; the server
 * is not.
 *
 * The canonical definition still lives in
 * `packages/types/src/den/llm-providers.ts` (the renderer reads it directly).
 * `den-llm-providers.test.ts` runs both implementations over the same fixture
 * matrix so the copies cannot drift silently. Types are imported type-only, so
 * they are erased from the emitted JavaScript.
 */
import type {
  LlmProviderConnectionWire,
  LlmProviderListWire,
  LlmProviderWire,
  LlmProviderWireModel,
  UnreadableLlmProvider,
} from "@sofia/types/den/llm-providers";

export type {
  LlmProviderConnectionWire,
  LlmProviderListWire,
  LlmProviderWire,
  LlmProviderWireModel,
  UnreadableLlmProvider,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRequiredString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readOptionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Accepts an object or a JSON-encoded object (MariaDB returns JSON as text). */
export function parseLlmProviderJsonRecord(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  if (typeof value !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseApiKeys(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) return null;
  const entries: Array<[string, string]> = [];
  for (const [key, credential] of Object.entries(value)) {
    if (typeof credential === "string" && credential.trim().length > 0) {
      entries.push([key, credential]);
    }
  }
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

function parseModel(value: unknown): LlmProviderWireModel | null {
  if (!isRecord(value)) return null;
  const id = readRequiredString(value.id);
  const name = readRequiredString(value.name);
  if (!id || !name) return null;
  return {
    id,
    name,
    config: parseLlmProviderJsonRecord(value.config),
    createdAt: readOptionalString(value.createdAt),
  };
}

function parseProvider(value: unknown): LlmProviderWire | null {
  if (!isRecord(value)) return null;
  const id = readRequiredString(value.id);
  const providerId = readRequiredString(value.providerId);
  const name = readRequiredString(value.name);
  if (!id || !providerId || !name) return null;

  const models: LlmProviderWireModel[] = [];
  if (Array.isArray(value.models)) {
    for (const modelValue of value.models) {
      const model = parseModel(modelValue);
      if (model) models.push(model);
    }
  }

  return {
    id,
    providerId,
    name,
    source: readOptionalString(value.source),
    providerConfig: parseLlmProviderJsonRecord(value.providerConfig),
    hasApiKey: value.hasApiKey === true,
    models,
    createdAt: readOptionalString(value.createdAt),
    updatedAt: readOptionalString(value.updatedAt),
  };
}

/**
 * Reads `{ llmProviders: [...] }`. Returns `null` when the payload is not a
 * provider list at all — a wrong origin, an HTML error page served with 200, or
 * a renamed envelope — so callers can decide whether that is fatal or empty.
 */
export function parseLlmProviderList(payload: unknown): LlmProviderListWire | null {
  if (!isRecord(payload) || !Array.isArray(payload.llmProviders)) return null;

  const providers: LlmProviderWire[] = [];
  const unreadable: UnreadableLlmProvider[] = [];
  for (const value of payload.llmProviders) {
    const provider = parseProvider(value);
    if (provider) {
      providers.push(provider);
      continue;
    }
    unreadable.push({
      id: isRecord(value) ? readOptionalString(value.id) ?? "" : "",
      name: isRecord(value) ? readOptionalString(value.name) ?? "" : "",
    });
  }
  return { providers, unreadable };
}

/** Reads `{ llmProvider: {...} }`, optionally asserting it is the provider we asked for. */
export function parseLlmProviderConnection(
  payload: unknown,
  expectedId?: string,
): LlmProviderConnectionWire | null {
  if (!isRecord(payload) || !isRecord(payload.llmProvider)) return null;
  const provider = parseProvider(payload.llmProvider);
  if (!provider) return null;
  if (expectedId !== undefined && provider.id !== expectedId) return null;
  return {
    ...provider,
    apiKey: typeof payload.llmProvider.apiKey === "string" ? payload.llmProvider.apiKey : null,
    apiKeys: parseApiKeys(payload.llmProvider.apiKeys),
  };
}
