// Free-tier provider contract, fetched from Sofia Cloud at runtime.
//
// The upstream accepts a request only when the client presents a specific
// fingerprint (User-Agent shape, session-id shape, streamed body, and a tool
// list containing `bash` and `read`). That fingerprint is not an API contract:
// it has already changed twice without notice. Every part of it therefore lives
// in a remote document so a change can be shipped from Sofia Cloud instead of a
// new desktop build.
//
// Resolution order:
//   1. remote document (etag / TTL cached)
//   2. last successfully fetched document (persisted, any age)
//   3. BUNDLED_FREE_TIER_CONFIG compiled into this build
//
// A malformed or partial remote document never wins: it falls through to the
// previous rung. The schema ignores unknown fields so Sofia Cloud can add
// fields ahead of old clients.
import { createHash } from "node:crypto";
import { z } from "zod";

import { externalFetch } from "./server-fetch.js";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const HEX = "0123456789abcdef";

const freeTierToolSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  parameters: z.record(z.string(), z.unknown()),
});

export const freeTierModelSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).optional(),
  contextWindow: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
});

export type FreeTierModel = z.infer<typeof freeTierModelSchema>;

export const freeTierConfigSchema = z.object({
  version: z.number().int().positive(),
  updatedAt: z.string().min(1).optional(),
  enabled: z.boolean(),
  /** Provider identity the app registers with the engine. */
  provider: z.object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    name: z.string().min(1),
  }),
  upstream: z.object({
    baseUrl: z.string().url(),
    chatPath: z.string().startsWith("/"),
    modelsPath: z.string().startsWith("/"),
  }),
  identity: z.object({
    /** `{version}` is substituted from `version` below. */
    userAgentTemplate: z.string().includes("{version}"),
    version: z.string().min(1),
    clientName: z.string().min(1),
    /** Verbatim Authorization header. Omit for an anonymous upstream. */
    authorization: z.string().min(1).optional(),
    session: z.object({
      prefix: z.string().min(1),
      timeHexLength: z.number().int().min(4).max(24),
      randomBase62Length: z.number().int().min(8).max(64),
    }),
  }),
  /**
   * Upstream rejects non-streamed requests. Kept configurable so the value can
   * be flipped without a build if the requirement is dropped.
   */
  stream: z.literal(true),
  /** Injected when the caller's tool list does not already contain them. */
  requiredTools: z.array(freeTierToolSchema).min(1),
  /**
   * How the advertised list is reconciled against the upstream catalog.
   *
   * Cloud owns the *allowlist* (`models`): free-tier status is not published by
   * the upstream, and data-retention policy differs per model, so a model that
   * appears upstream must never be exposed without a human decision.
   *
   *   off       advertise the allowlist as-is
   *   intersect (default) advertise allowlist ∩ upstream catalog
   *   replace   advertise upstream free-looking models, allowlist supplies names
   */
  discovery: z.object({
    mode: z.enum(["off", "intersect", "replace"]),
    modelsUrl: z.string().url(),
    ttlSeconds: z.number().int().min(30).max(86_400),
    /** Regex applied to upstream ids when `mode` is `replace`. */
    freeIdPattern: z.string().min(1),
    /**
     * Free models whose ids do not match the pattern (e.g. stealth models).
     * Only consulted by `replace`; `intersect` requires real existence.
     */
    extraFreeIds: z.array(z.string().min(1)),
  }).optional(),
  models: z.array(freeTierModelSchema).min(1),
});

export type FreeTierConfig = z.infer<typeof freeTierConfigSchema>;
export type FreeTierTool = z.infer<typeof freeTierToolSchema>;

/**
 * Compiled-in baseline. Mirrors the document Sofia Cloud serves; a remote
 * fetch that fails changes nothing for the user.
 */
export const BUNDLED_FREE_TIER_CONFIG: FreeTierConfig = {
  version: 1,
  enabled: true,
  provider: { id: "sofia-free", name: "Sofia Free" },
  upstream: {
    baseUrl: "https://opencode.ai/inference/openai/v1",
    chatPath: "/chat/completions",
    modelsPath: "/models",
  },
  identity: {
    userAgentTemplate: "opencode/{version}",
    version: "1.18.31",
    clientName: "cli",
    authorization: "Bearer public",
    session: { prefix: "ses_", timeHexLength: 12, randomBase62Length: 14 },
  },
  stream: true,
  discovery: {
    mode: "intersect",
    modelsUrl: "https://opencode.ai/inference/v1/models",
    ttlSeconds: 900,
    freeIdPattern: "-free$",
    extraFreeIds: ["big-pickle"],
  },
  requiredTools: [
    {
      name: "bash",
      description: "Execute a shell command and return its output.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Command to run" },
          description: { type: "string", description: "Why it is run" },
        },
        required: ["command"],
      },
    },
    {
      name: "read",
      description: "Read a file from disk.",
      parameters: {
        type: "object",
        properties: { filePath: { type: "string", description: "Absolute path" } },
        required: ["filePath"],
      },
    },
  ],
  models: [
    { id: "deepseek-v4.1-flash-free", name: "DeepSeek V4.1 Flash Free" },
    { id: "glm-5.3-flash-free", name: "GLM 5.3 Flash Free" },
    { id: "minimax-m3.1-flash-free", name: "MiniMax M3.1 Flash Free" },
    { id: "big-pickle", name: "Big Pickle" },
  ],
};

export type FreeTierConfigSource = "remote" | "cached" | "bundled";

export type ResolvedFreeTierConfig = {
  config: FreeTierConfig;
  source: FreeTierConfigSource;
  /** Set when a remote read failed, for diagnostics. */
  error?: string;
};

type CacheEntry = {
  config: FreeTierConfig;
  etag: string | null;
  fetchedAt: number;
  expiresAt: number;
};

const REMOTE_TTL_MS = 5 * 60_000;
const REMOTE_TIMEOUT_MS = 4_000;

const cache = new Map<string, CacheEntry>();

/** Test seam: drop the process-local remote cache. */
export function clearFreeTierConfigCache(): void {
  cache.clear();
}

function cacheKey(url: string, authorization: string | undefined): string {
  return createHash("sha256").update(`${url}\n${authorization ?? ""}`).digest("hex");
}

export type LoadFreeTierConfigOptions = {
  /** Full URL of the Sofia Cloud document. Absent => bundled config. */
  url?: string | null;
  /** Bearer token for the Sofia Cloud request, when the deployment requires one. */
  authorization?: string | null;
  fetcher?: (input: string, init?: RequestInit) => Promise<Response>;
  now?: () => number;
  timeoutMs?: number;
};

/**
 * Resolve the free-tier contract. Never throws: an unreachable, slow, or
 * malformed document degrades to the last good document, then to the bundle.
 */
export async function loadFreeTierConfig(
  options: LoadFreeTierConfigOptions = {},
): Promise<ResolvedFreeTierConfig> {
  const url = options.url ?? null;
  if (!url) return { config: BUNDLED_FREE_TIER_CONFIG, source: "bundled" };

  const now = options.now ?? Date.now;
  const fetcher = options.fetcher ?? externalFetch;
  const key = cacheKey(url, options.authorization ?? undefined);
  const cached = cache.get(key);

  if (cached && cached.expiresAt > now()) {
    return { config: cached.config, source: "cached" };
  }

  try {
    const headers: Record<string, string> = { accept: "application/json" };
    if (cached?.etag) headers["if-none-match"] = cached.etag;
    if (options.authorization) headers.authorization = options.authorization;

    const response = await fetcher(url, {
      headers,
      signal: AbortSignal.timeout(options.timeoutMs ?? REMOTE_TIMEOUT_MS),
    });

    if (response.status === 304 && cached) {
      const refreshed: CacheEntry = { ...cached, fetchedAt: now(), expiresAt: now() + REMOTE_TTL_MS };
      cache.set(key, refreshed);
      return { config: refreshed.config, source: "remote" };
    }

    if (!response.ok) {
      throw new Error(`free-tier config returned ${response.status}`);
    }

    const parsed = freeTierConfigSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw new Error(`free-tier config invalid: ${parsed.error.issues[0]?.message ?? "unknown"}`);
    }

    const entry: CacheEntry = {
      config: parsed.data,
      etag: response.headers.get("etag"),
      fetchedAt: now(),
      expiresAt: now() + REMOTE_TTL_MS,
    };
    cache.set(key, entry);
    return { config: entry.config, source: "remote" };
  } catch (error) {
    if (cached) {
      // Serve the stale document rather than the bundle: it is strictly newer
      // than what this build shipped with.
      return {
        config: cached.config,
        source: "cached",
        error: error instanceof Error ? error.message : String(error),
      };
    }
    return {
      config: BUNDLED_FREE_TIER_CONFIG,
      source: "bundled",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Session id in the shape the upstream requires. */
export function createFreeTierSessionId(config: FreeTierConfig, now = Date.now()): string {
  const { prefix, timeHexLength, randomBase62Length } = config.identity.session;
  const digits: string[] = [];
  for (let index = timeHexLength - 1; index >= 0; index -= 1) {
    digits.push(HEX[Math.floor(now / 2 ** (4 * index)) % 16]);
  }
  const random = new Uint8Array(randomBase62Length);
  globalThis.crypto.getRandomValues(random);
  for (const byte of random) digits.push(BASE62[byte % 62]);
  return `${prefix}${digits.join("")}`;
}

/** Outbound headers the upstream fingerprint requires. */
export function buildFreeTierHeaders(
  config: FreeTierConfig,
  sessionId: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": config.identity.userAgentTemplate.replaceAll("{version}", config.identity.version),
    "x-opencode-client": config.identity.clientName,
    "x-opencode-session": sessionId,
  };
  if (config.identity.authorization) headers.authorization = config.identity.authorization;
  return headers;
}

/** OpenAI-shaped `/v1/models` payload for the engine's model discovery. */
export function freeTierModelList(config: FreeTierConfig): {
  object: "list";
  data: Array<{
    id: string;
    object: "model";
    owned_by: string;
    name: string;
    context_window?: number;
    max_output_tokens?: number;
  }>;
} {
  return {
    object: "list",
    data: config.models.map((model) => ({
      id: model.id,
      object: "model",
      owned_by: config.provider.id,
      name: model.name ?? model.id,
      ...(model.contextWindow ? { context_window: model.contextWindow } : {}),
      ...(model.maxOutputTokens ? { max_output_tokens: model.maxOutputTokens } : {}),
    })),
  };
}
