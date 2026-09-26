// The connectable provider catalog — the single source of truth for which
// providers the app can connect, and how each one authenticates.
//
// This mirrors the engine's own provider registry
// (sofia-rs/model-provider-info/src/lib.rs `well_known_providers()` +
// `built_in_model_providers()`) so the app and the engine agree on provider
// ids, env-key names, base URLs and wire APIs. The engine discovers these
// providers automatically once the matching env var is set; the app drives the
// same set through its connect flow, so a provider connected in either surface
// behaves identically in the other.
//
// The catalog answers three questions the app used to answer with hardcoded
// literals:
//   1. Which providers exist and can be connected (previously: only `openai`,
//      from the hardcoded `/provider/auth` response).
//   2. Which auth method each provider offers — OAuth only where the engine
//      really implements a flow, API key otherwise.
//   3. Which env var holds a provider's credential, so a key entered in the UI
//      lands in the same slot the engine reads (previously: `env: []`, which
//      silently dropped every key before it was written).

export type CatalogProviderAuthMethod = "oauth" | "api";

export type CatalogProvider = {
  /** Engine provider id (`model_providers.<id>` in config.toml, `providers.json` key). */
  id: string;
  /** Display name. */
  name: string;
  /**
   * Env var the engine resolves the credential from. Also the key the app
   * writes to `sofia-auth.json`. `null` for providers that need no
   * credential (local Ollama/LM Studio, or providers that use another scheme).
   */
  envKey: string | null;
  /** Human-readable instructions for obtaining the credential, when useful. */
  envKeyInstructions?: string | null;
  /** Provider's OpenAI-compatible API base. `null` when the engine resolves it. */
  baseUrl: string | null;
  /** Wire protocol the provider speaks. */
  wireApi: "responses" | "chatcompletions";
  /** Auth methods this provider offers, in display order. */
  auth: CatalogProviderAuthMethod[];
  /** True when the provider is locally hosted and needs no credential. */
  local?: boolean;
};

const API_KEY_AUTH: CatalogProviderAuthMethod[] = ["api"];

/**
 * Providers whose credential the engine can obtain through a real OAuth flow.
 * ChatGPT sign-in is the only flow the engine implements today, so this stays
 * OpenAI-only until the engine grows more — the app must not offer a flow the
 * engine cannot complete.
 */
const OAUTH_CAPABLE_PROVIDERS: readonly string[] = ["openai"];

function apiKeyProvider(input: {
  id: string;
  name: string;
  envKey: string;
  baseUrl: string;
  wireApi?: "responses" | "chatcompletions";
  envKeyInstructions?: string;
}): CatalogProvider {
  return {
    id: input.id,
    name: input.name,
    envKey: input.envKey,
    envKeyInstructions: input.envKeyInstructions ?? null,
    baseUrl: input.baseUrl,
    wireApi: input.wireApi ?? "chatcompletions",
    auth: API_KEY_AUTH,
  };
}

/**
 * The connectable catalog, mirroring the engine's well-known provider set.
 * Order is display order in the connect modal.
 */
export const CONNECTABLE_PROVIDERS: readonly CatalogProvider[] = [
  {
    id: "openai",
    name: "OpenAI",
    envKey: "OPENAI_API_KEY",
    envKeyInstructions: "Create an API key at platform.openai.com.",
    baseUrl: null,
    wireApi: "responses",
    // The engine signs in to OpenAI through ChatGPT OAuth; the API key path
    // stays available for users who authenticate with their own key.
    auth: ["oauth", "api"],
  },
  apiKeyProvider({
    id: "anthropic",
    name: "Anthropic",
    envKey: "ANTHROPIC_API_KEY",
    baseUrl: "https://api.anthropic.com/v1",
    envKeyInstructions: "Create an API key at console.anthropic.com.",
  }),
  apiKeyProvider({
    id: "openrouter",
    name: "OpenRouter",
    envKey: "OPENROUTER_API_KEY",
    baseUrl: "https://openrouter.ai/api/v1",
    envKeyInstructions: "Create an API key at openrouter.ai/keys.",
  }),
  apiKeyProvider({
    id: "groq",
    name: "Groq",
    envKey: "GROQ_API_KEY",
    baseUrl: "https://api.groq.com/openai/v1",
    envKeyInstructions: "Create an API key at console.groq.com/keys.",
  }),
  apiKeyProvider({
    id: "deepseek",
    name: "DeepSeek",
    envKey: "DEEPSEEK_API_KEY",
    baseUrl: "https://api.deepseek.com/v1",
    envKeyInstructions: "Create an API key at platform.deepseek.com.",
  }),
  apiKeyProvider({
    id: "together",
    name: "Together AI",
    envKey: "TOGETHER_API_KEY",
    baseUrl: "https://api.together.xyz/v1",
    envKeyInstructions: "Create an API key at api.together.ai/settings/api-keys.",
  }),
  apiKeyProvider({
    id: "mistral",
    name: "Mistral AI",
    envKey: "MISTRAL_API_KEY",
    baseUrl: "https://api.mistral.ai/v1",
    envKeyInstructions: "Create an API key at console.mistral.ai.",
  }),
  apiKeyProvider({
    id: "xiaomi",
    name: "Xiaomi (MiMo)",
    envKey: "XIAOMI_API_KEY",
    baseUrl: "https://api.xiaomimimo.com/v1",
    envKeyInstructions: "Create an API key at platform.xiaomimimo.com.",
  }),
  apiKeyProvider({
    id: "fireworks",
    name: "Fireworks AI",
    envKey: "FIREWORKS_API_KEY",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    envKeyInstructions: "Create an API key at fireworks.ai.",
  }),
  apiKeyProvider({
    id: "cerebras",
    name: "Cerebras",
    envKey: "CEREBRAS_API_KEY",
    baseUrl: "https://api.cerebras.ai/v1",
    envKeyInstructions: "Create an API key at cloud.cerebras.ai.",
  }),
  apiKeyProvider({
    id: "google",
    name: "Google Gemini",
    envKey: "GEMINI_API_KEY",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    envKeyInstructions: "Create an API key at aistudio.google.com/apikey.",
  }),
  apiKeyProvider({
    id: "cohere",
    name: "Cohere",
    envKey: "COHERE_API_KEY",
    baseUrl: "https://api.cohere.com/v2",
    envKeyInstructions: "Create an API key at dashboard.cohere.com.",
  }),
  apiKeyProvider({
    id: "perplexity",
    name: "Perplexity",
    envKey: "PERPLEXITY_API_KEY",
    baseUrl: "https://api.perplexity.ai",
    envKeyInstructions: "Create an API key at perplexity.ai/settings/api.",
  }),
  apiKeyProvider({
    id: "xai",
    name: "xAI (Grok)",
    envKey: "XAI_API_KEY",
    baseUrl: "https://api.x.ai/v1",
    envKeyInstructions: "Create an API key at console.x.ai.",
  }),
  {
    id: "ollama",
    name: "Ollama (local)",
    envKey: null,
    baseUrl: "http://localhost:11434/v1",
    wireApi: "responses",
    auth: [],
    local: true,
  },
  {
    id: "lmstudio",
    name: "LM Studio (local)",
    envKey: null,
    baseUrl: "http://localhost:1234/v1",
    wireApi: "responses",
    auth: [],
    local: true,
  },
];

/** Providers that expose at least one way to authenticate. */
export function connectableProviders(): CatalogProvider[] {
  return CONNECTABLE_PROVIDERS.filter((provider) => provider.auth.length > 0);
}

export function catalogProvider(providerId: string): CatalogProvider | null {
  const wanted = providerId.trim().toLowerCase();
  if (!wanted) return null;
  return (
    CONNECTABLE_PROVIDERS.find(
      (provider) => provider.id === wanted || provider.envKey?.toLowerCase() === wanted,
    ) ?? null
  );
}

/**
 * Auth methods for a single provider, in the shape `/provider/auth` returns.
 * Only providers with a real engine-side flow get an `oauth` entry; everything
 * else authenticates with an API key.
 */
function authMethodsFor(providerId: string): Array<{ type: CatalogProviderAuthMethod; label: string }> {
  const methods: Array<{ type: CatalogProviderAuthMethod; label: string }> = [];
  if (OAUTH_CAPABLE_PROVIDERS.includes(providerId)) {
    methods.push({ type: "oauth", label: "Sign in with ChatGPT" });
    methods.push({ type: "oauth", label: "Headless device flow" });
  }
  methods.push({ type: "api", label: "API key" });
  return methods;
}

/**
 * Auth methods for every connectable provider, combining the static well-known
 * list with the full models.dev catalog.
 *
 * The static list is always included so the connect modal still works when the
 * catalog is unreachable; catalog providers are merged on top, and a provider
 * present in both keeps the static list's OAuth methods. This is what makes the
 * app offer the same providers as the CLI's `/connect` instead of a fixed 14.
 */
export function providerAuthMethodsById(opts?: {
  catalogProviderIds?: readonly string[];
}): Record<string, Array<{ type: CatalogProviderAuthMethod; label: string }>> {
  const methods: Record<string, Array<{ type: CatalogProviderAuthMethod; label: string }>> = {};
  for (const provider of connectableProviders()) {
    methods[provider.id] = authMethodsFor(provider.id);
  }
  for (const id of opts?.catalogProviderIds ?? []) {
    const providerId = id.trim();
    if (!providerId) continue;
    if (methods[providerId]) continue;
    // A catalog provider is API-key only: the engine implements no OAuth flow
    // for it, and offering one would strand the user mid-flow.
    methods[providerId] = [{ type: "api", label: "API key" }];
  }
  return methods;
}

/** True when the engine implements a real OAuth flow for this provider. */
export function hasEngineOAuthFlow(providerId: string): boolean {
  const provider = catalogProvider(providerId);
  return Boolean(provider && OAUTH_CAPABLE_PROVIDERS.includes(provider.id));
}
