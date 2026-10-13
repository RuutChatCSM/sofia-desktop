/**
 * The desktop provider wire contract.
 *
 * Both sides of the desktop read this payload: the renderer talks to the
 * control plane (Den or Sofia Cloud) directly, and the local server reads the
 * same `/v1/llm-providers` list to materialize providers for remote engines.
 * One parser means the schema tolerances cannot drift apart, and no layer bakes
 * in a particular backend's id scheme — Sofia Cloud serves its managed provider
 * as `sofia-cloud`, while Den mints `lpr_...` TypeIDs.
 *
 * Parsing is intentionally tolerant: a provider (or one of its models) we
 * cannot read is dropped and reported instead of failing the whole list.
 */

export type LlmProviderWireModel = {
  id: string;
  name: string;
  config: Record<string, unknown>;
  createdAt: string | null;
};

export type LlmProviderWire = {
  id: string;
  source: string | null;
  providerId: string;
  name: string;
  providerConfig: Record<string, unknown>;
  hasApiKey: boolean;
  models: LlmProviderWireModel[];
  createdAt: string | null;
  updatedAt: string | null;
};

export type LlmProviderConnectionWire = LlmProviderWire & {
  apiKey: string | null;
  /**
   * Per-env-var credentials for providers whose config declares several env
   * keys (e.g. AWS Bedrock). Servers send either `apiKey` or `apiKeys`, never
   * both.
   */
  apiKeys: Record<string, string> | null;
};

/** A listed provider that could not be read, kept so callers can report it. */
export type UnreadableLlmProvider = {
  id: string;
  name: string;
};

export type LlmProviderListWire = {
  providers: LlmProviderWire[];
  unreadable: UnreadableLlmProvider[];
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
