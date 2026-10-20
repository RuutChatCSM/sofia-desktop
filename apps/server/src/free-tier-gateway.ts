// Loopback gateway that presents the remote free tier as a local
// OpenAI-compatible provider.
//
// The engine is pointed at `http://127.0.0.1:<port>/free-tier/v1`, so:
//   * egress leaves from the user's own machine (the upstream binds nothing to
//     an account IP, and we do not want Sofia Cloud proxying user prompts);
//   * the fingerprint is applied in exactly one place, from remote config;
//   * the user can switch the provider off without touching engine config.
import type { FreeTierConfig, FreeTierTool } from "./free-tier-config.js";
import { buildFreeTierHeaders, freeTierModelList } from "./free-tier-config.js";

const HOP_BY_HOP = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonError(status: number, code: string, message: string, detail?: string): Response {
  return new Response(
    JSON.stringify({ error: { code, message, ...(detail ? { detail } : {}) } }),
    { status, headers: { "content-type": "application/json" } },
  );
}

export type FreeTierGatewayOptions = {
  config: FreeTierConfig;
  sessionId: string;
  fetcher: (input: string, init?: RequestInit) => Promise<Response>;
  /** Called when the upstream refuses work for a model (429/5xx). */
  onModelUnavailable?: (modelId: string) => void;
};

/**
 * Force the two body requirements the upstream enforces. Both are idempotent:
 * a caller that already streams and already passes its own `bash`/`read`
 * definitions is left untouched.
 */
export function prepareFreeTierChatBody(
  config: FreeTierConfig,
  body: JsonRecord,
): { body: JsonRecord; injectedTools: string[] } {
  const tools: unknown[] = Array.isArray(body.tools) ? [...body.tools] : [];
  const present = new Set<string>();
  for (const tool of tools) {
    if (!isRecord(tool) || !isRecord(tool.function)) continue;
    const name = tool.function.name;
    if (typeof name === "string") present.add(name);
  }

  const injectedTools: string[] = [];
  for (const required of config.requiredTools as FreeTierTool[]) {
    if (present.has(required.name)) continue;
    tools.push({ type: "function", function: required });
    injectedTools.push(required.name);
  }

  return {
    body: {
      ...body,
      stream: config.stream,
      ...(tools.length > 0 ? { tools } : {}),
    },
    injectedTools,
  };
}

/** Resolve `<baseUrl><chatPath>` without letting a config path escape the base. */
export function freeTierEndpoint(config: FreeTierConfig, path: "chat" | "models"): string {
  const base = config.upstream.baseUrl.replace(/\/+$/, "");
  const suffix = path === "chat" ? config.upstream.chatPath : config.upstream.modelsPath;
  return `${base}${suffix}`;
}

/**
 * Forward one chat completion. The upstream status and body are preserved so
 * the engine's own retry/error handling keeps working; only a fingerprint
 * rejection is translated, because it needs an app-level explanation.
 */
export async function proxyFreeTierChat(
  options: FreeTierGatewayOptions,
  body: unknown,
): Promise<Response> {
  if (!isRecord(body)) return jsonError(400, "invalid_request", "Expected a JSON object body.");
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return jsonError(400, "invalid_request", "`messages` must be a non-empty array.");
  }

  const prepared = prepareFreeTierChatBody(options.config, body);
  const headers = buildFreeTierHeaders(options.config, options.sessionId);

  let upstream: Response;
  try {
    upstream = await options.fetcher(freeTierEndpoint(options.config, "chat"), {
      method: "POST",
      headers,
      body: JSON.stringify(prepared.body),
    });
  } catch (error) {
    return jsonError(
      502,
      "free_tier_unreachable",
      "The free model upstream could not be reached.",
      error instanceof Error ? error.message : String(error),
    );
  }

  if (upstream.status === 403) {
    const detail = await upstream.text();
    const rejected = detail.includes("FreeTierError");
    return jsonError(
      502,
      rejected ? "free_tier_fingerprint_rejected" : "free_tier_forbidden",
      rejected
        ? "The free model upstream rejected this client fingerprint. Refresh the free-tier config from Sofia Cloud, or pick another model."
        : "The free model upstream refused the request.",
      detail.slice(0, 500),
    );
  }

  // A model that is rate-limited or whose backend is down should stop being
  // advertised on this machine, without waiting for a cloud refresh.
  if ((upstream.status === 429 || upstream.status >= 500) && typeof body.model === "string") {
    options.onModelUnavailable?.(body.model);
  }

  const responseHeaders = new Headers();
  for (const [name, value] of upstream.headers) {
    if (!HOP_BY_HOP.has(name.toLowerCase())) responseHeaders.set(name, value);
  }
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

/** `/v1/models` for the engine's discovery pass. */
export function freeTierModelsResponse(
  config: FreeTierConfig,
  models: FreeTierConfig["models"],
): Response {
  if (!config.enabled) {
    return jsonError(503, "free_tier_disabled", "The free model tier is disabled by configuration.");
  }
  return new Response(JSON.stringify(freeTierModelList({ ...config, models })), {
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/**
 * The gateway is an unauthenticated egress proxy, so it must only ever answer
 * requests that already came from this machine.
 */
export function isLoopbackRequest(request: Request): boolean {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return false;
  const host = request.headers.get("host");
  if (!host) return false;
  const hostname = host.replace(/:\d+$/, "").toLowerCase();
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]" || hostname === "::1";
}
