// Codex engine routes: an additive HTTP surface for the codex runtime that
// lives alongside the opencode routes. Exposes:
//   GET  /workspace/:id/codex/engine          -> engine info + session list
//   POST /workspace/:id/codex/sessions        -> create a codex thread/session
//   POST /workspace/:id/codex/sessions/:sid/prompt
//   POST /workspace/:id/codex/sessions/:sid/abort
//   DELETE /workspace/:id/codex/sessions/:sid
//   GET  /workspace/:id/codex/stream          -> SSE event stream
import { randomUUID } from "node:crypto";

import { removeCodexAuthKey, setCodexAuthKey } from "./codex-auth-store.js";
import { ensureProviderModels } from "./codex-model-discovery.js";
import {
  codexEnvKeyForProvider,
  parseCodexEngineConfig,
  readCodexEngineConfig,
  writeCodexEngineConfigFromProviders,
} from "./codex-providers.js";
import type { CodexEvent, CodexSession } from "./codex-sessions.js";
import { CodexSteerError, isCodexSessionId } from "./codex-sessions.js";
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
    prompt: (sessionId: string, text: string, opts?: { model?: string; providerId?: string }) => Promise<CodexSession>;
    steer: (sessionId: string, text: string) => Promise<CodexSession>;
    abort: (sessionId: string) => Promise<void>;
    delete: (sessionId: string) => Promise<void>;
    setArchived: (sessionId: string, archived: boolean) => Promise<CodexSession>;
    rename: (sessionId: string, title: string) => Promise<CodexSession>;
    getSessionItems: (sessionId: string, options?: { limit?: number }) => Promise<Array<{ turnId: string; item: Record<string, unknown> }>>;
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

export interface RegisterCodexRoutesOptions {
  routes: Route[];
  config: ServerConfig;
  readJsonBody: ReadJsonBody;
  requireClientScope: RequireClientScope;
  ensureWritable: EnsureWritable;
  registry: CodexSessionRegistry;
}

export function registerCodexRoutes(options: RegisterCodexRoutesOptions): void {
  const { routes, readJsonBody, requireClientScope, ensureWritable, registry } = options;
  const notFound = (message: string) => new ApiError(404, "not_found", message);
  const workspaceManager = async (workspaceId: string) => registry.getOrCreate(workspaceId);

  // Wrap codex session operations so any engine failure surfaces as a
  // "Sofia request failed" ApiError instead of a bare 500 or an opencode
  // error code (the codex runtime is the Sofia engine).
  const sofiaRequest = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof ApiError) throw error;
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

  // Provider auth methods the app's provider-auth modal offers. The Sofia
  // engine signs in to OpenAI via ChatGPT OAuth (browser or headless device
  // code); every other provider is configured with an API key, which the app
  // adds on its own.
  addRoute(routes, "GET", "/workspace/:id/provider/auth", "client", async () => {
    return jsonResponse({
      openai: [
        { type: "oauth", label: "Sign in with ChatGPT" },
        { type: "oauth", label: "Headless device flow" },
      ],
    });
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
    const manager = await workspaceManager(ctx.params.id);
    if (!isCodexSessionId(ctx.params.sessionId)) throw notFound("unknown codex session");
    const session = await sofiaRequest(() => manager.prompt(ctx.params.sessionId, text, {
      model: optionalStringField(body, "model"),
      providerId: optionalStringField(body, "providerId"),
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
    const manager = await workspaceManager(ctx.params.id);
    if (!isCodexSessionId(ctx.params.sessionId)) throw notFound("unknown codex session");
    try {
      const session = await manager.steer(ctx.params.sessionId, text);
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
    const items = await sofiaRequest(() => manager.getSessionItems(ctx.params.sessionId, { limit: 200 }));
    return jsonResponse({ ok: true, items });
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

  // Codex auth store: the app writes the same provider API key the user enters
  // in the UI here (mirroring opencode's auth API), and the codex engine reads
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
    // Mirror codex's `/connect`: the credential is stored under the derived
    // `<ID>_API_KEY` name the engine resolves via config.toml's `env_key`. The
    // app-provided name (if different) is kept too so nothing is orphaned.
    await setCodexAuthKey(providerId, codexEnvKeyForProvider(providerId), key);
    if (providedEnvKey && providedEnvKey !== codexEnvKeyForProvider(providerId)) {
      await setCodexAuthKey(providerId, providedEnvKey, key);
    }
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
    await removeCodexAuthKey(codexEnvKeyForProvider(providerId));
    if (providedEnvKey && providedEnvKey !== codexEnvKeyForProvider(providerId)) {
      await removeCodexAuthKey(providedEnvKey);
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
}
