// Loopback routes that expose the remote free tier as a local
// OpenAI-compatible provider plus a small status surface for Settings.
//
// Auth is `none` because the engine speaks to this surface on 127.0.0.1 and
// has no Sofia token; every handler therefore re-checks that the request came
// from loopback. This surface must never be reachable from the network.
import type { ServerConfig } from "../types.js";
import {
  createFreeTierSessionId,
  loadFreeTierConfig,
  type ResolvedFreeTierConfig,
} from "../free-tier-config.js";
import { externalFetch } from "../server-fetch.js";
import {
  freeTierModelsResponse,
  isLoopbackRequest,
  proxyFreeTierChat,
} from "../free-tier-gateway.js";
import { freeTierProviderRecord } from "../free-tier-provider.js";
import { createFreeTierModelRegistry, type FreeTierModelRegistry } from "../free-tier-models.js";
import { ApiError } from "../errors.js";
import { addRoute, type Route } from "./registry.js";

type JsonResponse = (data: unknown, status?: number) => Response;
type ReadJsonBody = (request: Request) => Promise<Record<string, unknown>>;
type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export type RegisterFreeTierRoutesOptions = {
  routes: Route[];
  config: ServerConfig;
  jsonResponse: JsonResponse;
  readJsonBody: ReadJsonBody;
  /** Sofia Cloud document URL. Defaults to `SOFIA_FREE_TIER_CONFIG_URL`. */
  configUrl?: string | null;
  /** Bearer token for that document. Defaults to `SOFIA_FREE_TIER_CONFIG_TOKEN`. */
  configAuthorization?: string | null;
  fetcher?: Fetcher;
  now?: () => number;
  /** Applies the engine-side provider entry; wired to the runtime config store. */
  onEnabledChange?: (enabled: boolean) => Promise<{ changed: boolean; enabled: boolean }>;
  /** Whether the engine currently knows the provider. */
  isProviderRegistered?: () => Promise<boolean>;
};

type FreeTierState = {
  resolved: ResolvedFreeTierConfig;
  sessionId: string;
  models: FreeTierModelRegistry;
};

/**
 * One resolution per config version per process. The upstream uses the session
 * id for affinity, so it is reused until the remote document changes; the model
 * registry is rebuilt with it so a new allowlist takes effect immediately.
 */
function createState(
  getResolved: () => Promise<ResolvedFreeTierConfig>,
  createModels: (config: ResolvedFreeTierConfig["config"]) => FreeTierModelRegistry,
): () => Promise<FreeTierState> {
  let state: FreeTierState | null = null;
  return async () => {
    const resolved = await getResolved();
    if (!state || state.resolved.config.version !== resolved.config.version) {
      state = {
        resolved,
        sessionId: createFreeTierSessionId(resolved.config),
        models: createModels(resolved.config),
      };
    } else {
      state = { ...state, resolved };
    }
    return state;
  };
}

function loopbackGuard(request: Request): void {
  if (!isLoopbackRequest(request)) {
    throw new ApiError(403, "loopback_only", "The free-tier gateway is only reachable on this machine.");
  }
}

export function registerFreeTierRoutes(options: RegisterFreeTierRoutesOptions): void {
  const { routes, config, jsonResponse, readJsonBody } = options;
  const configUrl = options.configUrl ?? process.env.SOFIA_FREE_TIER_CONFIG_URL ?? null;
  const configAuthorization = options.configAuthorization ?? process.env.SOFIA_FREE_TIER_CONFIG_TOKEN ?? null;

  const load = () =>
    loadFreeTierConfig({
      url: configUrl,
      authorization: configAuthorization,
      fetcher: options.fetcher,
      now: options.now,
    });

  const state = createState(
    load,
    (config) =>
      createFreeTierModelRegistry({
        config,
        fetcher: options.fetcher ?? externalFetch,
        now: options.now,
      }),
  );

  // Model discovery: allowlist reconciled with the upstream catalog, minus
  // models that just refused work on this machine.
  addRoute(routes, "GET", "/free-tier/v1/models", "none", async ({ request }) => {
    loopbackGuard(request);
    const { resolved, models } = await state();
    const list = await models.list();
    return freeTierModelsResponse(resolved.config, list.models);
  });

  addRoute(routes, "POST", "/free-tier/v1/chat/completions", "none", async ({ request }) => {
    loopbackGuard(request);
    const body = await readJsonBody(request);
    const { resolved, sessionId, models } = await state();
    return proxyFreeTierChat(
      {
        config: resolved.config,
        sessionId,
        fetcher: options.fetcher ?? externalFetch,
        onModelUnavailable: models.markUnavailable,
      },
      body,
    );
  });

  // Settings/UI surface: which contract is in force, where it came from, and
  // why it may have degraded. Never includes the Authorization header value.
  addRoute(routes, "GET", "/free-tier/status", "client", async () => {
    const { resolved, models } = await state();
    const list = await models.list();
    const providerEnabled = options.isProviderRegistered
      ? await options.isProviderRegistered()
      : false;
    return jsonResponse({
      enabled: resolved.config.enabled,
      providerEnabled,
      source: resolved.source,
      version: resolved.config.version,
      updatedAt: resolved.config.updatedAt ?? null,
      provider: resolved.config.provider,
      models: list.models,
      modelSource: list.source,
      ...(list.withdrawn.length > 0 ? { withdrawn: list.withdrawn } : {}),
      identity: {
        version: resolved.config.identity.version,
        userAgentTemplate: resolved.config.identity.userAgentTemplate,
        hasAuthorization: Boolean(resolved.config.identity.authorization),
      },
      discovery: resolved.config.discovery?.mode ?? "off",
      ...(resolved.error ? { error: resolved.error } : {}),
      ...(list.error ? { modelError: list.error } : {}),
    });
  });

  // Enable/disable. Writes the engine-side provider entry and reloads the
  // engine; the loopback gateway keeps running either way so a toggle is
  // reversible without restarting the server.
  addRoute(routes, "POST", "/free-tier/enabled", "client", async ({ request }) => {
    if (!options.onEnabledChange) {
      throw new ApiError(503, "free_tier_unavailable", "This server cannot manage the free-tier provider.");
    }
    const body = await readJsonBody(request);
    if (typeof body.enabled !== "boolean") {
      throw new ApiError(400, "invalid_payload", "`enabled` must be a boolean.");
    }
    return jsonResponse(await options.onEnabledChange(body.enabled));
  });

  // The engine-catalog entry, so the app does not hardcode the shape.
  addRoute(routes, "GET", "/free-tier/provider", "client", async () => {
    const { resolved, models } = await state();
    const list = await models.list();
    return jsonResponse({
      provider: resolved.config.provider.id,
      config: freeTierProviderRecord(
        { ...resolved.config, models: list.models },
        `http://127.0.0.1:${config.port}`,
      ),
    });
  });
}
