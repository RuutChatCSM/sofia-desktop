// Codex engine routes: an additive HTTP surface for the codex runtime that
// lives alongside the engine routes. Exposes:
//   GET  /workspace/:id/codex/engine          -> engine info + session list
//   POST /workspace/:id/codex/sessions        -> create a codex thread/session
//   POST /workspace/:id/codex/sessions/:sid/prompt
//   POST /workspace/:id/codex/sessions/:sid/abort
//   DELETE /workspace/:id/codex/sessions/:sid
//   GET  /workspace/:id/codex/stream          -> SSE event stream
import { randomUUID } from "node:crypto";

import { removeCodexAuthKey, setCodexAuthKey } from "./codex-auth-store.js";
import { getCatalogProvider, listCatalogProviders } from "./models-dev-catalog.js";
import { catalogProvider, providerAuthMethodsById } from "./provider-catalog.js";
import { discoverProviderModels, ensureProviderModels } from "./codex-model-discovery.js";
import {
  codexEnvKeyForProvider,
  parseCodexEngineConfig,
  readCodexEngineConfig,
  readCodexProviders,
  writeCodexEngineConfigFromProviders,
  writeCodexProviders,
} from "./codex-providers.js";
import type { BackgroundProcess, CodexEvent, CodexSession } from "./codex-sessions.js";
import { CodexSteerError, CodexThreadBusyError, MAX_TRANSCRIPT_ITEMS, isCodexSessionId } from "./codex-sessions.js";
import type { CodexAttentionHub } from "./codex-attention.js";
import { ApiError } from "./errors.js";
import { addRoute, type RequestContext, type Route } from "./routes/registry.js";
import type { ServerConfig, TokenScope } from "./types.js";

type ReadJsonBody = (request: Request) => Promise<Record<string, unknown>>;
type RequireClientScope = (ctx: RequestContext, required: TokenScope) => void;
type EnsureWritable = (config: ServerConfig) => void;

export interface CodexSessionRegistry {
  getOrCreate(workspaceId: string): Promise<{
    engineInfo: unknown;
    start: () => Promise<void>;
    listSessions: () => CodexSession[];
    createSession: (input: { title: string; prompt?: string; workspaceId: string; cwd?: string; model?: string; providerId?: string }) => Promise<CodexSession>;
    prompt: (sessionId: string, text: string, opts?: { model?: string; providerId?: string; images?: string[] }) => Promise<CodexSession>;
    steer: (sessionId: string, text: string, images?: string[]) => Promise<CodexSession>;
    abort: (sessionId: string) => Promise<void>;
    delete: (sessionId: string) => Promise<void>;
    setArchived: (sessionId: string, archived: boolean) => Promise<CodexSession>;
    rename: (sessionId: string, title: string) => Promise<CodexSession>;
    forkSession: (sessionId: string, options?: { messageId?: string | null }) => Promise<CodexSession>;
    getSessionItems: (sessionId: string, options?: { limit?: number }) => Promise<Array<{ turnId: string; item: Record<string, unknown> }>>;
    listBackgroundProcesses: (sessionId: string) => Promise<BackgroundProcess[]>;
    terminateBackgroundProcess: (sessionId: string, processId: string) => Promise<boolean>;
    cleanBackgroundProcesses: (sessionId: string) => Promise<void>;
    on: (listener: (event: CodexEvent) => void) => () => void;
  }>;
}

function sseEncode(event: CodexEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function optionalStringField(body: Record<string, unknown>, name: string): string | undefined {
  const value = body[name];
  return typeof value === "string" ? value : undefined;
}

/** Optional list of image data URLs to attach to a turn. */
function optionalStringArrayField(body: Record<string, unknown>, name: string): string[] | undefined {
  const value = body[name];
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return items.length ? items : undefined;
}

export interface RegisterCodexRoutesOptions {
  routes: Route[];
  config: ServerConfig;
  readJsonBody: ReadJsonBody;
  requireClientScope: RequireClientScope;
  ensureWritable: EnsureWritable;
  registry: CodexSessionRegistry;
  /**
   * Cross-workspace attention hub. When provided, the server exposes the
   * attention feed that stays live regardless of which workspace the renderer
   * is viewing.
   */
  attention?: CodexAttentionHub;
  /**
   * Fetch used when a connect-time model discovery probes a provider's
   * `/models` endpoint. Defaults to the server's external egress; tests inject a
   * stub. Discovery already accepts a fetch override, so this only forwards it.
   */
  providerDiscoveryFetch?: typeof fetch;
}

export function registerCodexRoutes(options: RegisterCodexRoutesOptions): void {
  const { routes, readJsonBody, requireClientScope, ensureWritable, registry } = options;
  const providerDiscoveryFetch = options.providerDiscoveryFetch;
  const notFound = (message: string) => new ApiError(404, "not_found", message);
  const workspaceManager = async (workspaceId: string) => registry.getOrCreate(workspaceId);

  // Wrap codex session operations so any engine failure surfaces as a
  // "Sofia request failed" ApiError instead of a bare 500 or an engine
  // error code (the codex runtime is the Sofia engine).
  const sofiaRequest = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof ApiError) throw error;
      // A live writer elsewhere is not a server fault: report it as a conflict
      // the client can explain ("open elsewhere") instead of a generic 502 with
      // the reason buried in details.
      if (error instanceof CodexThreadBusyError) {
        throw new ApiError(409, "thread_writer_conflict", error.message, { threadId: error.threadId });
      }
      console.error("[sofia-server] Sofia request failed:", error instanceof Error ? error.message : String(error));
      throw new ApiError(502, "sofia_request_failed", "Sofia request failed", {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  };

  addRoute(routes, "GET", "/workspace/:id/codex/engine", "client", async ({ params }) => {
    try {
      const manager = await workspaceManager(params.id);
      // Start the engine so persisted threads load from thread/list — without
      // this the session list is empty until the first session is created.
      await manager.start();
      return jsonResponse({ ok: true, engine: manager.engineInfo, sessions: manager.listSessions() });
    } catch (error) {
      // Codex binary not configured for this workspace yet: report an empty
      // engine state instead of a 500 so the UI can show "not available".
      if (error instanceof Error && /codex binary is not configured/.test(error.message)) {
        return jsonResponse({ ok: true, engine: null, sessions: [] });
      }
      throw error;
    }
  });

  // Codex model/provider config: what the app's model picker surfaces when the
  // selected engine is codex. Read from the app-owned codexengine.json.
  addRoute(routes, "GET", "/workspace/:id/codex/config", "client", async () => {
    // Providers persisted by the CLI's `/connect` flow always carry a catalog
    // in practice, but a provider whose `/models` response the CLI could not
    // parse lands with `models: []` and would vanish from the picker. Resolve
    // those catalogs from the provider before flattening the config.
    await ensureProviderModels().catch(() => undefined);
    const config = await readCodexEngineConfig();
    return jsonResponse({ ok: true, config });
  });

  // Provider auth methods the app's provider-auth modal offers. Derived from
  // the shared connectable catalog (mirroring the engine's own provider
  // registry) instead of a hardcoded list, so every provider the engine knows
  // how to authenticate is connectable from the app. OAuth entries appear only
  // for providers the engine can actually complete a flow for; the rest
  // authenticate with an API key.
  addRoute(routes, "GET", "/workspace/:id/provider/auth", "client", async () => {
    // Merge the full models.dev catalog over the static well-known list so the
    // app offers every provider the CLI's `/connect` does, not a fixed 14. A
    // catalog outage degrades to the static list rather than an empty modal.
    const catalog = await listCatalogProviders({ fetchImpl: providerDiscoveryFetch }).catch(() => []);
    return jsonResponse(providerAuthMethodsById({ catalogProviderIds: catalog.map((entry) => entry.id) }));
  });

  // The app pushes its connected providers (with models.dev-backed models) here
  // so the codex engine's provider/model catalog stays in sync with what the
  // picker shows — including providers connected only via the app's auth store.
  addRoute(routes, "PUT", "/workspace/:id/codex/providers", "client", async (ctx) => {
    ensureWritable(options.config);
    requireClientScope(ctx, "collaborator");
    const body = await readJsonBody(ctx.request);
    const parsed = parseCodexEngineConfig(body);
    if (parsed.providers.length === 0) {
      throw new ApiError(400, "invalid_payload", "providers are required");
    }
    const path = await writeCodexEngineConfigFromProviders(parsed.providers);
    return jsonResponse({ ok: true, path });
  });

  addRoute(routes, "POST", "/workspace/:id/codex/sessions", "client", async (ctx) => {
    ensureWritable(options.config);
    requireClientScope(ctx, "collaborator");
    const body = await readJsonBody(ctx.request);
    const title = optionalStringField(body, "title") ?? "Sofia task";
    const prompt = optionalStringField(body, "prompt");
    const cwd = optionalStringField(body, "cwd");
    const model = optionalStringField(body, "model");
    const providerId = optionalStringField(body, "providerId");
    const manager = await workspaceManager(ctx.params.id);
    const session = await sofiaRequest(() => manager.createSession({ title, prompt, workspaceId: ctx.params.id, cwd, model, providerId }));
    return jsonResponse({ ok: true, session }, 201);
  });

  addRoute(routes, "POST", "/workspace/:id/codex/sessions/:sessionId/prompt", "client", async (ctx) => {
    ensureWritable(options.config);
    requireClientScope(ctx, "collaborator");
    const body = await readJsonBody(ctx.request);
    const text = optionalStringField(body, "text");
    if (!text) throw new ApiError(400, "invalid_payload", "text is required");
    const images = optionalStringArrayField(body, "images");
    const manager = await workspaceManager(ctx.params.id);
    if (!isCodexSessionId(ctx.params.sessionId)) throw notFound("unknown codex session");
    const session = await sofiaRequest(() => manager.prompt(ctx.params.sessionId, text, {
      model: optionalStringField(body, "model"),
      providerId: optionalStringField(body, "providerId"),
      images,
    }));
    return jsonResponse({ ok: true, session });
  });

  // Steer an in-flight turn with a follow-up message (codex `turn/steer`).
  // Mirrors the Codex app: while the agent is working, a new message is injected
  // into the current turn rather than rejected. Structured 409s let the client
  // fall back (start a turn on `no_active_turn`, queue on `not_steerable`).
  addRoute(routes, "POST", "/workspace/:id/codex/sessions/:sessionId/steer", "client", async (ctx) => {
    ensureWritable(options.config);
    requireClientScope(ctx, "collaborator");
    const body = await readJsonBody(ctx.request);
    const text = optionalStringField(body, "text");
    if (!text) throw new ApiError(400, "invalid_payload", "text is required");
    const images = optionalStringArrayField(body, "images");
    const manager = await workspaceManager(ctx.params.id);
    if (!isCodexSessionId(ctx.params.sessionId)) throw notFound("unknown codex session");
    try {
      const session = await manager.steer(ctx.params.sessionId, text, images);
      return jsonResponse({ ok: true, session });
    } catch (error) {
      if (error instanceof CodexSteerError) {
        throw new ApiError(409, `codex_${error.code}`, error.message, {
          ...(error.actualTurnId ? { actualTurnId: error.actualTurnId } : {}),
        });
      }
      throw new ApiError(502, "sofia_request_failed", "Sofia request failed", {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // Restore a codex session's persisted items (for building a transcript).
  addRoute(routes, "GET", "/workspace/:id/codex/sessions/:sessionId/items", "client", async (ctx) => {
    const manager = await workspaceManager(ctx.params.id);
    if (!isCodexSessionId(ctx.params.sessionId)) throw notFound("unknown codex session");
    // The engine pages ~100 items at a time; the manager follows the cursors so
    // opening a task shows its whole transcript, not just the beginning.
    const items = await sofiaRequest(() => manager.getSessionItems(ctx.params.sessionId, { limit: MAX_TRANSCRIPT_ITEMS }));
    return jsonResponse({ ok: true, items });
  });

  // Background processes the agent started through unified exec. The list is
  // the server's merged view (engine live set + tracked exit status/output), so
  // a client that reconnects sees the same picture the stream would have built.
  addRoute(routes, "GET", "/workspace/:id/codex/sessions/:sessionId/background-processes", "client", async (ctx) => {
    const manager = await workspaceManager(ctx.params.id);
    if (!isCodexSessionId(ctx.params.sessionId)) throw notFound("unknown codex session");
    const processes = await sofiaRequest(() => manager.listBackgroundProcesses(ctx.params.sessionId));
    return jsonResponse({ ok: true, processes });
  });

  // Stop every background process on the session's thread.
  addRoute(routes, "POST", "/workspace/:id/codex/sessions/:sessionId/background-processes/clean", "client", async (ctx) => {
    ensureWritable(options.config);
    requireClientScope(ctx, "collaborator");
    const manager = await workspaceManager(ctx.params.id);
    if (!isCodexSessionId(ctx.params.sessionId)) throw notFound("unknown codex session");
    await sofiaRequest(() => manager.cleanBackgroundProcesses(ctx.params.sessionId));
    return jsonResponse({ ok: true });
  });

  // Terminate one background process. `processId` is the engine handle (never
  // an OS pid); the manager also accepts the item id as a fallback.
  addRoute(routes, "POST", "/workspace/:id/codex/sessions/:sessionId/background-processes/:processId/terminate", "client", async (ctx) => {
    ensureWritable(options.config);
    requireClientScope(ctx, "collaborator");
    const manager = await workspaceManager(ctx.params.id);
    if (!isCodexSessionId(ctx.params.sessionId)) throw notFound("unknown codex session");
    const terminated = await sofiaRequest(() =>
      manager.terminateBackgroundProcess(ctx.params.sessionId, ctx.params.processId));
    return jsonResponse({ ok: true, terminated });
  });

  addRoute(routes, "POST", "/workspace/:id/codex/sessions/:sessionId/abort", "client", async (ctx) => {
    ensureWritable(options.config);
    requireClientScope(ctx, "collaborator");
    const manager = await workspaceManager(ctx.params.id);
    if (!isCodexSessionId(ctx.params.sessionId)) throw notFound("unknown codex session");
    await sofiaRequest(() => manager.abort(ctx.params.sessionId));
    return jsonResponse({ ok: true });
  });

  addRoute(routes, "DELETE", "/workspace/:id/codex/sessions/:sessionId", "client", async (ctx) => {
    ensureWritable(options.config);
    requireClientScope(ctx, "collaborator");
    const manager = await workspaceManager(ctx.params.id);
    if (!isCodexSessionId(ctx.params.sessionId)) throw notFound("unknown codex session");
    await sofiaRequest(() => manager.delete(ctx.params.sessionId));
    return jsonResponse({ ok: true });
  });

  // Branch a conversation into a new thread at a message boundary.
  addRoute(routes, "POST", "/workspace/:id/codex/sessions/:sessionId/fork", "client", async (ctx) => {
    ensureWritable(options.config);
    requireClientScope(ctx, "collaborator");
    const manager = await workspaceManager(ctx.params.id);
    if (!isCodexSessionId(ctx.params.sessionId)) throw notFound("unknown codex session");
    const body = await readJsonBody(ctx.request).catch(() => null);
    const messageId = optionalStringField(body ?? {}, "messageId");
    const session = await sofiaRequest(() => manager.forkSession(ctx.params.sessionId, { messageId }));
    return jsonResponse({ ok: true, session });
  });

  for (const action of ["archive", "rename"] as const) {
    addRoute(routes, "POST", `/workspace/:id/codex/sessions/:sessionId/${action}`, "client", async (ctx) => {
      ensureWritable(options.config);
      requireClientScope(ctx, "collaborator");
      if (!isCodexSessionId(ctx.params.sessionId)) throw notFound("unknown Sofia task");
      const body = await readJsonBody(ctx.request);
      const manager = await workspaceManager(ctx.params.id);
      if (action === "archive") {
        if (typeof body.archived !== "boolean") throw new ApiError(400, "invalid_payload", "archived must be a boolean");
        const archived = body.archived;
        return jsonResponse({ ok: true, session: await sofiaRequest(() => manager.setArchived(ctx.params.sessionId, archived)) });
      }
      const title = optionalStringField(body, "title")?.trim();
      if (!title) throw new ApiError(400, "invalid_payload", "title is required");
      return jsonResponse({ ok: true, session: await sofiaRequest(() => manager.rename(ctx.params.sessionId, title)) });
    });
  }

  /**
   * Every env var name a provider's credential may be stored under.
   *
   * The engine resolves a single `env_key` per provider, but the catalog lists
   * several aliases for some (`google` -> GOOGLE_API_KEY,
   * GOOGLE_GENERATIVE_AI_API_KEY, GEMINI_API_KEY). Writing all of them means the
   * engine finds the key whichever name its built-in registry uses.
   */
  async function providerEnvKeys(providerId: string): Promise<string[]> {
    const id = providerId.trim().toLowerCase();
    if (!id) return [];
    const catalogEntry = await getCatalogProvider(id, { fetchImpl: providerDiscoveryFetch }).catch(() => null);
    const keys = catalogEntry?.envKeys ?? [];
    const known = catalogProvider(id);
    if (known?.envKey) keys.push(known.envKey);
    return keys;
  }

  /**
   * Make sure a provider the user just connected exists in the engine's
   * provider catalog (`providers.json`) and is immediately usable.
   *
   * Storing the credential alone is not enough: the app renders providers
   * through their models and the engine only knows a provider that has a
   * catalog entry, so a key written for an unknown provider produced a
   * connection the user could never see or select. This is the registration
   * step `/connect` performs when it writes a new provider.
   *
   * A provider with an empty model catalog is still invisible in the picker, so
   * registration resolves the catalog from the provider's `/models` endpoint
   * before returning. Discovery is best-effort: a provider that cannot be
   * reached still gets a catalog entry and stays registered, and the deferred
   * retry on the next config read fills it in.
   *
   * Existing entries are left untouched so a connected provider's already
   * discovered models are never discarded by a key rotation.
   */
  async function ensureProviderRegistered(providerId: string): Promise<void> {
    const id = providerId.trim();
    if (!id) return;
    const file = await readCodexProviders();
    if (file.providers[id]) {
      // Already registered. Still resolve an empty catalog so a provider that
      // failed to discover earlier becomes selectable without a reconnect.
      await resolveRegisteredProviderModels();
      return;
    }
    // Prefer the models.dev entry (base URL, display name) and fall back to the
    // static well-known list when the catalog is unavailable.
    const catalogEntry = await getCatalogProvider(id, { fetchImpl: providerDiscoveryFetch }).catch(() => null);
    const known = catalogProvider(id);
    const baseUrl = catalogEntry?.baseUrl ?? known?.baseUrl ?? "";
    file.providers[id] = {
      api_key: "",
      base_url: baseUrl,
      wire_api: catalogEntry ? "chat_completions" : known?.wireApi === "responses" ? "responses" : "chat_completions",
      name: catalogEntry?.name ?? known?.name ?? id,
      // Seed the catalog's own model list so a provider the user connects is
      // immediately selectable, before (or without) a live /models probe.
      models: (catalogEntry?.models ?? []).map((model) => ({
        id: model.id,
        name: model.name,
        reasoning: model.reasoning,
        contextWindow: model.contextWindow,
      })),
    };
    await writeCodexProviders(file);
    await resolveRegisteredProviderModels();
  }

  /**
   * Populate a freshly registered provider's model catalog from its `/models`
   * endpoint. Never throws: a provider that cannot be reached keeps its empty
   * catalog and is retried on the next config read.
   */
  async function resolveRegisteredProviderModels(): Promise<void> {
    try {
      await discoverProviderModels(providerDiscoveryFetch ? { fetchImpl: providerDiscoveryFetch } : undefined);
    } catch {
      // Discovery is best-effort; the provider stays registered regardless.
    }
  }

  // Codex auth store: the app writes the same provider API key the user enters
  // in the UI here (mirroring engine's auth API), and the codex engine reads
  // it at spawn to inject into its child env. Stored server-side in the global
  // user config dir (codex-auth.json).
  addRoute(routes, "PUT", "/workspace/:id/codex/auth/:providerId", "client", async (ctx) => {
    ensureWritable(options.config);
    requireClientScope(ctx, "collaborator");
    const body = await readJsonBody(ctx.request);
    const providedEnvKey = optionalStringField(body, "envKey");
    const key = optionalStringField(body, "key");
    if (!key) {
      throw new ApiError(400, "invalid_payload", "key is required");
    }
    const providerId = decodeURIComponent(ctx.params.providerId);
    // Mirror codex's `/connect`: the credential is stored under the name the
    // engine resolves via config.toml's `env_key`. The catalog's env var is
    // authoritative when the app did not send one; otherwise the derived
    // `<ID>_API_KEY` name matches. Every distinct name is written so nothing is
    // orphaned — the engine may look up any of them.
    const names = new Set<string>();
    for (const name of [
      providedEnvKey,
      ...(await providerEnvKeys(providerId)),
      codexEnvKeyForProvider(providerId),
    ]) {
      if (name?.trim()) names.add(name.trim());
    }
    for (const name of names) {
      await setCodexAuthKey(providerId, name, key);
    }
    await ensureProviderRegistered(providerId);
    return jsonResponse({ ok: true });
  });

  addRoute(routes, "DELETE", "/workspace/:id/codex/auth/:providerId", "client", async (ctx) => {
    ensureWritable(options.config);
    requireClientScope(ctx, "collaborator");
    const providerId = decodeURIComponent(ctx.params.providerId);
    const body = await readJsonBody(ctx.request).catch(() => null);
    const providedEnvKey = body && typeof body.envKey === "string" && body.envKey.trim()
      ? body.envKey.trim()
      : null;
    // Mirror the PUT route: clear every env name this provider's credential may
    // be stored under, so a disconnect never leaves a key the engine can read.
    const names = new Set<string>();
    for (const name of [
      providedEnvKey,
      ...(await providerEnvKeys(providerId)),
      codexEnvKeyForProvider(providerId),
    ]) {
      if (name?.trim()) names.add(name.trim());
    }
    for (const name of names) {
      await removeCodexAuthKey(name);
    }
    return jsonResponse({ ok: true });
  });

  // SSE event stream: emits every CodexEvent as a `data:` frame. A single
  // subscriber per workspace is expected (the session sync layer). We keep the
  // connection open until the client aborts.
  addRoute(routes, "GET", "/workspace/:id/codex/stream", "client", async ({ params, request }) => {
    const manager = await workspaceManager(params.id);
    await manager.start();
    const streamId = randomUUID();
    const encoder = new TextEncoder();
    let closed = false;
    let unsubscribe = () => {};
    const controllerRef: { controller: ReadableStreamDefaultController<Uint8Array> | null } = { controller: null };

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controllerRef.controller = controller;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "stream.ready", streamId })}\n\n`));
      },
      cancel() {
        closed = true;
        unsubscribe();
      },
    });

    unsubscribe = manager.on((event) => {
      if (closed || !controllerRef.controller) return;
      try {
        controllerRef.controller.enqueue(encoder.encode(sseEncode(event)));
      } catch {
        closed = true;
        unsubscribe();
      }
    });

    // Replay existing sessions so a reconnecting client sees current state.
    for (const session of manager.listSessions()) {
      if (closed || !controllerRef.controller) break;
      try {
        controllerRef.controller.enqueue(
          encoder.encode(sseEncode({ type: "session.created", session })),
        );
      } catch {
        closed = true;
        break;
      }
    }

    request.signal.addEventListener("abort", () => {
      closed = true;
      unsubscribe();
      try { controllerRef.controller?.close(); } catch { /* already closed */ }
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
  });

  // Cross-workspace attention feed: only the transitions that need the user,
  // from every workspace this server observes. It is deliberately not
  // workspace-scoped, so a background failure is seen while the renderer shows
  // another workspace (or while the app was closed — pending events replay
  // until acknowledged).
  if (options.attention) {
    const attention = options.attention;

    addRoute(routes, "GET", "/codex/attention", "client", async ({ request }) => {
      const encoder = new TextEncoder();
      let closed = false;
      let unsubscribe = () => {};
      const controllerRef: { controller: ReadableStreamDefaultController<Uint8Array> | null } = { controller: null };

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controllerRef.controller = controller;
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "stream.ready" })}\n\n`));
        },
        cancel() {
          closed = true;
          unsubscribe();
        },
      });

      unsubscribe = attention.on((event) => {
        if (closed || !controllerRef.controller) return;
        try {
          controllerRef.controller.enqueue(encoder.encode(sseEncode(event)));
        } catch {
          closed = true;
          unsubscribe();
        }
      });

      for (const event of attention.pendingEvents()) {
        if (closed || !controllerRef.controller) break;
        try {
          controllerRef.controller.enqueue(encoder.encode(sseEncode(event)));
        } catch {
          closed = true;
          break;
        }
      }

      request.signal.addEventListener("abort", () => {
        closed = true;
        unsubscribe();
        try { controllerRef.controller?.close(); } catch { /* already closed */ }
      });

      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        },
      });
    });

    addRoute(routes, "POST", "/codex/attention/ack", "client", async (ctx) => {
      const body = await readJsonBody(ctx.request).catch(() => null);
      const sessionId = body && typeof body.sessionId === "string" ? body.sessionId : "";
      const itemId = body && typeof body.itemId === "string" ? body.itemId : "";
      if (!sessionId || !itemId) {
        throw new ApiError(400, "invalid_payload", "sessionId and itemId are required");
      }
      attention.acknowledge({ sessionId, itemId });
      return jsonResponse({ ok: true });
    });
  }
}
