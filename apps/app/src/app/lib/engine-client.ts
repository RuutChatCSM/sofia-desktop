// Engine client: the app-side replacement for the Sofia SDK.
//
// Every method the UI used to call on the Sofia SDK client is preserved but
// re-pointed at the Sofia App server's adapter-backed REST routes
// (`/workspace/:id/...`) and the native Codex surface (`/workspace/:id/codex/*`).
// Return values keep the SDK's `{ data, error, response }` envelope so existing
// `unwrap`/`assertNoClientError` call sites stay unchanged.
import { desktopFetch } from "./desktop";
import { isDesktopRuntime } from "./runtime-env";
import { parseSofiaWorkspaceIdFromUrl } from "./sofia-server";
import type {
  Agent,
  Config,
  LspStatus,
  Message,
  Model,
  Part,
  PermissionRequest,
  PermissionV2Request,
  Project,
  ProviderAuthAuthorization,
  ProviderAuthResponse,
  ProviderListResponse,
  QuestionRequest,
  Session,
  SessionStatus,
  Todo,
  VcsInfo,
} from "./engine-types";

export type WorkspaceEngineAuth = {
  username?: string;
  password?: string;
  token?: string;
  mode?: "basic" | "sofia";
};

export type EngineResult<T> =
  | { ok: true; data: T; error: undefined; request: Request; response: Response }
  | { ok: false; data?: undefined; error: unknown; request: Request; response: Response };

export type EngineMcpServerStatus =
  | { status: "connected" }
  | { status: "disabled" }
  | { status: "failed"; error: string }
  | { status: "needs_auth" }
  | { status: "reconnect_required" }
  | { status: "needs_client_registration"; error: string };

export type EngineMcpStatusMap = Record<string, EngineMcpServerStatus>;

export type EngineClientOptions = {
  baseUrl: string;
  directory?: string;
  auth?: WorkspaceEngineAuth;
  headers?: Record<string, string>;
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  signal?: AbortSignal;
  throwOnError?: boolean;
};

type RequestOptions = {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

type EngineMount = {
  host: string;
  workspaceId: string | null;
};

function resolveEngineMount(baseUrl: string, directory?: string): EngineMount {
  const raw = baseUrl.replace(/\/+$/, "");
  const workspaceId = parseSofiaWorkspaceIdFromUrl(raw) ?? directory?.trim() ?? null;
  let host = raw;
  try {
    const url = new URL(raw);
    url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/engine$/, "");
    const match = url.pathname.match(/^(.*)\/(?:w|workspace)\/[^/]+$/);
    if (match) url.pathname = match[1] || "/";
    url.search = "";
    url.hash = "";
    host = url.toString().replace(/\/+$/, "");
  } catch {
    host = raw.replace(/\/engine$/, "");
  }
  return { host, workspaceId: workspaceId || null };
}

function buildAuthHeader(auth?: WorkspaceEngineAuth): string | undefined {
  if (auth?.mode === "sofia" && auth.token) return `Bearer ${auth.token}`;
  if (auth?.token) return `Bearer ${auth.token}`;
  if (auth?.username && auth.password) {
    const token = `${auth.username}:${auth.password}`;
    if (typeof btoa === "function") return `Basic ${btoa(token)}`;
  }
  return undefined;
}

function partsToText(parts: unknown[] | undefined): string {
  if (!Array.isArray(parts)) return "";
  let text = "";
  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    const value = Reflect.get(part, "text");
    if (typeof value === "string") text += value;
  }
  return text;
}

function toModel(
  providerID: string,
  model: { id: string; name: string; reasoning?: boolean; contextWindow?: number | null },
): Model {
  return {
    id: model.id,
    providerID,
    api: { id: model.id, url: "", npm: "" },
    name: model.name,
    capabilities: {
      temperature: true,
      reasoning: model.reasoning === true,
      attachment: true,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: model.contextWindow ?? 0, output: 0 },
    status: "active",
    options: {},
    headers: {},
    release_date: "",
  };
}

type CodexProviderConfigWire = {
  providerId: string;
  providerName: string;
  models: Array<{ id: string; name: string; reasoning?: boolean; contextWindow?: number | null }>;
};

type CodexConfigWire = {
  defaultProviderId: string | null;
  model: string | null;
  providers: CodexProviderConfigWire[];
};

type CodexSessionWire = {
  id: string;
  title: string;
  workspaceId: string;
  created: string;
  cwd?: string;
};

type CodexEngineWire = {
  sessions?: CodexSessionWire[];
};

function codexSessionToSession(session: CodexSessionWire): Session {
  const created = Date.parse(session.created);
  return {
    id: session.id,
    slug: session.id,
    projectID: session.workspaceId,
    directory: session.cwd ?? "",
    title: session.title,
    version: "",
    time: {
      created: Number.isFinite(created) ? created : Date.now(),
      updated: Date.now(),
    },
  };
}

function codexEmptySession(sessionID: string): Session {
  return {
    id: sessionID,
    slug: sessionID,
    projectID: "",
    directory: "",
    title: "",
    version: "",
    time: { created: Date.now(), updated: Date.now() },
  };
}

function buildProviderList(config: CodexConfigWire): ProviderListResponse {
  const all = config.providers.map((provider) => ({
    id: provider.providerId,
    name: provider.providerName,
    source: "config" as const,
    env: [],
    options: {},
    models: Object.fromEntries(
      provider.models.map((model) => [model.id, toModel(provider.providerId, model)]),
    ),
  }));
  return {
    all,
    connected: config.providers.map((provider) => provider.providerId),
    default:
      config.defaultProviderId && config.model
        ? { [config.defaultProviderId]: config.model }
        : {},
  };
}

function buildMcpStatus(
  items: Array<{ name: string; disabledByTools?: boolean; managedOAuth?: { status?: string } | null }>,
): EngineMcpStatusMap {
  const statuses: EngineMcpStatusMap = {};
  for (const item of items) {
    const managed = item.managedOAuth?.status;
    if (managed === "needs_auth") {
      statuses[item.name] = { status: "needs_auth" };
    } else if (managed === "reconnect_required") {
      statuses[item.name] = { status: "reconnect_required" };
    } else if (item.disabledByTools === true) {
      statuses[item.name] = { status: "disabled" };
    } else {
      statuses[item.name] = { status: "connected" };
    }
  }
  return statuses;
}

function nativeFetch(): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  if (typeof window !== "undefined" && typeof window.fetch === "function") {
    return window.fetch.bind(window);
  }
  return globalThis.fetch.bind(globalThis);
}

async function* readEventStream(
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
): AsyncGenerator<unknown> {
  const response = await nativeFetch()(url, { headers, signal });
  if (!response.ok || !response.body) {
    throw new Error(`Event stream failed (${response.status} ${response.statusText || "HTTP error"})`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index: number;
    while ((index = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const dataLine = frame.split("\n").find((line) => line.startsWith("data:"));
      if (!dataLine) continue;
      const raw = dataLine.slice(5).trim();
      if (!raw) continue;
      try {
        yield JSON.parse(raw);
      } catch {
        // Skip malformed frames.
      }
    }
  }
}

function okResult<T>(data: T): EngineResult<T> {
  return {
    ok: true,
    data,
    error: undefined,
    request: new Request("http://engine.local/", { method: "GET" }),
    response: new Response(JSON.stringify(data), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  };
}

function failResult<T>(error: unknown, path: string): EngineResult<T> {
  return {
    ok: false,
    error,
    request: new Request(`http://engine.local${path}`, { method: "GET" }),
    response: new Response(null, { status: 501 }),
  };
}

function mapResult<T, U>(result: EngineResult<T>, map: (data: T) => U): EngineResult<U> {
  if (!result.ok) return result;
  return {
    ok: true,
    data: map(result.data),
    error: undefined,
    request: result.request,
    response: result.response,
  };
}

async function withTimeout(
  fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return fetchImpl(url, init);
  }
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const signal = controller?.signal;
  const initWithSignal = signal && !init.signal ? { ...init, signal } : init;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      try {
        controller?.abort();
      } catch {
        // ignore
      }
      reject(new Error("Request timed out."));
    }, timeoutMs);
  });
  try {
    return await Promise.race([fetchImpl(url, initWithSignal), timeoutPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

export function createEngineClient(options: EngineClientOptions) {
  const mount = resolveEngineMount(options.baseUrl, options.directory);
  const staticAuthHeader =
    options.headers?.Authorization ?? options.headers?.authorization ?? buildAuthHeader(options.auth);
  const fetchImpl = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (options.fetch) return options.fetch(input, init);
    const impl = isDesktopRuntime() ? desktopFetch : globalThis.fetch;
    return impl(input, init);
  };

  const workspacePath = (workspaceId: string): string => `/workspace/${encodeURIComponent(workspaceId)}`;

  async function request<T>(path: string, requestOptions: RequestOptions = {}): Promise<EngineResult<T>> {
    const url = `${mount.host}${path}`;
    const headers = new Headers({ "content-type": "application/json" });
    if (staticAuthHeader && !headers.has("authorization")) headers.set("authorization", staticAuthHeader);
    const init: RequestInit = {
      method: requestOptions.method ?? "GET",
      headers,
      signal: requestOptions.signal ?? options.signal,
    };
    if (requestOptions.body !== undefined) init.body = JSON.stringify(requestOptions.body);
    const timeoutMs = requestOptions.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    let response: Response;
    try {
      response = await withTimeout(fetchImpl, url, init, timeoutMs);
    } catch (error) {
      return {
        ok: false,
        error,
        request: new Request(url, { method: init.method }),
        response: new Response(null, { status: 500 }),
      };
    }
    const text = await response.text();
    const request = new Request(url, { method: init.method });
    if (!response.ok) {
      let error: unknown = text || response.statusText;
      try {
        error = text ? JSON.parse(text) : error;
      } catch {
        // Keep the raw text error.
      }
      return { ok: false, error, request, response };
    }
    const data = text ? JSON.parse(text) : undefined;
    return { ok: true, data, error: undefined, request, response };
  }

  function workspaceId(): string | null {
    return mount.workspaceId;
  }

  const client = {
    session: {
      async list(
        params: { directory?: string; roots?: boolean; start?: number; search?: string; limit?: number } = {},
      ): Promise<EngineResult<Session[]>> {
        const id = workspaceId();
        if (!id) return failResult("Workspace is not mounted on this server.", "/sessions");
        const query = new URLSearchParams();
        if (typeof params.roots === "boolean") query.set("roots", String(params.roots));
        if (typeof params.start === "number") query.set("start", String(params.start));
        if (params.search?.trim()) query.set("search", params.search.trim());
        if (typeof params.limit === "number") query.set("limit", String(params.limit));
        const suffix = query.size ? `?${query.toString()}` : "";
        return mapResult(
          await request<{ items: Session[] }>(`${workspacePath(id)}/sessions${suffix}`),
          (data) => data.items,
        );
      },

      async get(params: { sessionID: string; directory?: string }): Promise<EngineResult<Session>> {
        const id = workspaceId();
        if (!id) return failResult("Workspace is not mounted on this server.", "/sessions");
        if (params.sessionID.startsWith("codex-")) {
          const engine = await request<CodexEngineWire>(`${workspacePath(id)}/codex/engine`);
          if (!engine.ok) return engine;
          const found = engine.data.sessions?.find((session) => session.id === params.sessionID);
          if (!found) return failResult("Session not found", `/sessions/${params.sessionID}`);
          return {
            ok: true,
            data: codexSessionToSession(found),
            error: undefined,
            request: engine.request,
            response: engine.response,
          };
        }
        return mapResult(
          await request<{ item: Session }>(`${workspacePath(id)}/sessions/${encodeURIComponent(params.sessionID)}`),
          (data) => data.item,
        );
      },

      async messages(
        params: { sessionID: string; directory?: string; limit?: number },
      ): Promise<EngineResult<Array<{ info: Message; parts: Part[] }>>> {
        const id = workspaceId();
        if (!id) return failResult("Workspace is not mounted on this server.", "/sessions");
        if (params.sessionID.startsWith("codex-")) {
          return okResult([]);
        }
        const query = new URLSearchParams();
        if (typeof params.limit === "number") query.set("limit", String(params.limit));
        const suffix = query.size ? `?${query.toString()}` : "";
        return mapResult(
          await request<{ items: Array<{ info: Message; parts: Part[] }> }>(
            `${workspacePath(id)}/sessions/${encodeURIComponent(params.sessionID)}/messages${suffix}`,
          ),
          (data) => data.items,
        );
      },

      async todo(params: { sessionID: string; directory?: string }): Promise<EngineResult<Todo[]>> {
        const id = workspaceId();
        if (!id) return failResult("Workspace is not mounted on this server.", "/sessions");
        if (params.sessionID.startsWith("codex-")) return okResult([]);
        return mapResult(
          await request<{ item: { todos: Todo[] } }>(
            `${workspacePath(id)}/sessions/${encodeURIComponent(params.sessionID)}/snapshot`,
          ),
          (data) => data.item.todos,
        );
      },

      async status(
        _params?: unknown,
        requestOptions?: { signal?: AbortSignal },
      ): Promise<EngineResult<Record<string, SessionStatus>>> {
        const id = workspaceId();
        if (!id) return failResult("Workspace is not mounted on this server.", "/sessions");
        return mapResult(
          await request<{ items: Array<{ id: string; status?: string }> }>(`${workspacePath(id)}/sessions`, {
            signal: requestOptions?.signal,
          }),
          (data) => {
            const statuses: Record<string, SessionStatus> = {};
            for (const item of data.items) {
              statuses[item.id] = item.status === "busy" ? { type: "busy" } : { type: "idle" };
            }
            return statuses;
          },
        );
      },

      async create(params: { directory?: string; title?: string } = {}): Promise<EngineResult<Session>> {
        const id = workspaceId();
        if (!id) return failResult("Workspace is not mounted on this server.", "/sessions");
        return mapResult(
          await request<{ item: Session }>(`${workspacePath(id)}/sessions`, {
            method: "POST",
            body: { title: params.title?.trim() || "New session" },
            timeoutMs: 60_000,
          }),
          (data) => data.item,
        );
      },

      async update(params: {
        sessionID: string;
        directory?: string;
        title?: string;
        time?: { archived?: number };
      }): Promise<EngineResult<Session>> {
        const id = workspaceId();
        if (!id) return failResult("Workspace is not mounted on this server.", "/sessions");
        const sessionPath = `${workspacePath(id)}/codex/sessions/${encodeURIComponent(params.sessionID)}`;
        if (params.time?.archived !== undefined) {
          return mapResult(
            await request<{ session?: Session }>(`${sessionPath}/archive`, {
              method: "POST",
              body: { archived: params.time.archived !== 0 },
            }),
            (data) => data.session ?? codexEmptySession(params.sessionID),
          );
        }
        if (params.title?.trim()) {
          return mapResult(
            await request<{ session?: Session }>(`${sessionPath}/rename`, {
              method: "POST",
              body: { title: params.title.trim() },
            }),
            (data) => data.session ?? codexEmptySession(params.sessionID),
          );
        }
        return okResult(codexEmptySession(params.sessionID));
      },

      async delete(params: { sessionID: string; directory?: string }): Promise<EngineResult<Record<string, never>>> {
        const id = workspaceId();
        if (!id) return failResult("Workspace is not mounted on this server.", "/sessions");
        const path = params.sessionID.startsWith("codex-")
          ? `${workspacePath(id)}/codex/sessions/${encodeURIComponent(params.sessionID)}`
          : `${workspacePath(id)}/sessions/${encodeURIComponent(params.sessionID)}`;
        return await request<Record<string, never>>(path, { method: "DELETE", timeoutMs: 30_000 });
      },

      async abort(params: { sessionID: string; directory?: string }): Promise<EngineResult<boolean>> {
        const id = workspaceId();
        if (!id) return failResult("Workspace is not mounted on this server.", "/sessions");
        const path = params.sessionID.startsWith("codex-")
          ? `${workspacePath(id)}/codex/sessions/${encodeURIComponent(params.sessionID)}/abort`
          : `${workspacePath(id)}/sessions/${encodeURIComponent(params.sessionID)}/abort`;
        return mapResult(
          await request<{ ok?: boolean }>(path, { method: "POST", timeoutMs: 30_000 }),
          (data) => data.ok !== false,
        );
      },

      async promptAsync(params: {
        sessionID: string;
        directory?: string;
        model?: { providerID: string; modelID: string };
        agent?: string;
        variant?: string;
        system?: string;
        parts?: unknown[];
        reasoning_effort?: string;
      }): Promise<EngineResult<Record<string, never>>> {
        const id = workspaceId();
        if (!id) return failResult("Workspace is not mounted on this server.", "/sessions");
        return await request<Record<string, never>>(
          `${workspacePath(id)}/codex/sessions/${encodeURIComponent(params.sessionID)}/prompt`,
          {
            method: "POST",
            body: {
              text: partsToText(params.parts),
              ...(params.model ? { model: params.model.modelID, providerId: params.model.providerID } : {}),
              ...(params.reasoning_effort ? { reasoningEffort: params.reasoning_effort } : {}),
            },
            timeoutMs: 60_000,
          },
        );
      },

      async command(params: {
        sessionID: string;
        directory?: string;
        command: string;
        arguments?: string;
        model?: string;
        agent?: string;
        variant?: string;
        parts?: unknown[];
        reasoning_effort?: string;
      }): Promise<EngineResult<Record<string, never>>> {
        const id = workspaceId();
        if (!id) return failResult("Workspace is not mounted on this server.", "/sessions");
        const commandText = `/${params.command}${params.arguments ? ` ${params.arguments}` : ""}`;
        const bodyText = partsToText(params.parts);
        const modelParts = typeof params.model === "string" ? params.model.split("/") : [];
        const providerId = modelParts.length > 1 ? modelParts[0] : undefined;
        const modelId = modelParts.length > 1 ? modelParts.slice(1).join("/") : undefined;
        return await request<Record<string, never>>(
          `${workspacePath(id)}/codex/sessions/${encodeURIComponent(params.sessionID)}/prompt`,
          {
            method: "POST",
            body: {
              text: bodyText ? `${commandText}\n${bodyText}` : commandText,
              ...(providerId && modelId ? { providerId, model: modelId } : {}),
            },
            timeoutMs: 60_000,
          },
        );
      },

      async shell(params: {
        sessionID: string;
        command: string;
        directory?: string;
      }): Promise<EngineResult<Record<string, never>>> {
        const id = workspaceId();
        if (!id) return failResult("Workspace is not mounted on this server.", "/sessions");
        return await request<Record<string, never>>(
          `${workspacePath(id)}/codex/sessions/${encodeURIComponent(params.sessionID)}/prompt`,
          { method: "POST", body: { text: params.command }, timeoutMs: 60_000 },
        );
      },

      async summarize(params: {
        sessionID: string;
        directory?: string;
        providerID: string;
        modelID: string;
      }): Promise<EngineResult<Record<string, never>>> {
        const id = workspaceId();
        if (!id) return failResult("Workspace is not mounted on this server.", "/sessions");
        return await request<Record<string, never>>(
          `${workspacePath(id)}/codex/sessions/${encodeURIComponent(params.sessionID)}/prompt`,
          {
            method: "POST",
            body: { text: "/compact", providerId: params.providerID, model: params.modelID },
            timeoutMs: 60_000,
          },
        );
      },

      async revert(params: { sessionID: string; messageID?: string }): Promise<EngineResult<Session>> {
        return failResult("Session revert is not supported by the Sofia engine.", `/session/${params.sessionID}/revert`);
      },

      async fork(params: { sessionID: string; messageID?: string }): Promise<EngineResult<Session>> {
        return failResult("Session fork is not supported by the Sofia engine.", `/session/${params.sessionID}/fork`);
      },

      async unrevert(params: { sessionID: string }): Promise<EngineResult<Session>> {
        return failResult("Session revert is not supported by the Sofia engine.", `/session/${params.sessionID}/unrevert`);
      },
    },

    global: {
      async health(): Promise<EngineResult<{ healthy: boolean; version: string | null }>> {
        return mapResult(
          await request<{ ok?: boolean; version?: string }>("/health", { timeoutMs: 5_000 }),
          (data) => ({ healthy: data.ok === true, version: data.version ?? null }),
        );
      },
    },

    event: {
      async subscribe(
        _params?: unknown,
        requestOptions?: { signal?: AbortSignal },
      ): Promise<{ stream: AsyncIterable<unknown> }> {
        const id = workspaceId();
        if (!id) {
          return {
            stream: (async function* emptyStream() {
              // No mounted workspace: nothing to subscribe to.
            })(),
          };
        }
        const url = `${mount.host}${workspacePath(id)}/codex/stream`;
        const headers: Record<string, string> = {};
        if (staticAuthHeader) headers.authorization = staticAuthHeader;
        const signal = requestOptions?.signal ?? options.signal ?? new AbortController().signal;
        return { stream: readEventStream(url, headers, signal) };
      },
    },

    provider: {
      async list(params: { directory?: string } = {}): Promise<EngineResult<ProviderListResponse>> {
        void params;
        const id = workspaceId();
        if (!id) return failResult("Workspace is not mounted on this server.", "/codex/config");
        return mapResult(
          await request<{ config: CodexConfigWire }>(`${workspacePath(id)}/codex/config`),
          (data) => buildProviderList(data.config),
        );
      },

      async auth(): Promise<EngineResult<ProviderAuthResponse>> {
        const id = workspaceId();
        if (!id) return failResult("Workspace is not mounted on this server.", "/provider/auth");
        return await request<ProviderAuthResponse>(`${workspacePath(id)}/provider/auth`);
      },

      oauth: {
        async authorize(params: {
          providerID: string;
          method: number;
        }): Promise<EngineResult<ProviderAuthAuthorization>> {
          return failResult(
            `OAuth for ${params.providerID} is handled by the Sofia engine connect flow.`,
            "/provider/oauth/authorize",
          );
        },
        async callback(params: {
          providerID: string;
          method: number;
          code?: string;
        }): Promise<EngineResult<Record<string, never>>> {
          return failResult(
            `OAuth for ${params.providerID} is handled by the Sofia engine connect flow.`,
            "/provider/oauth/callback",
          );
        },
      },
    },

    mcp: {
      async status(params: { directory?: string } = {}): Promise<EngineResult<EngineMcpStatusMap>> {
        void params;
        const id = workspaceId();
        if (!id) return failResult("Workspace is not mounted on this server.", "/mcp");
        return mapResult(
          await request<{
            items: Array<{ name: string; disabledByTools?: boolean; managedOAuth?: { status?: string } | null }>;
          }>(`${workspacePath(id)}/mcp`),
          (data) => buildMcpStatus(data.items),
        );
      },

      async add(params: {
        directory?: string;
        name: string;
        config: Record<string, unknown>;
      }): Promise<EngineResult<EngineMcpStatusMap>> {
        const id = workspaceId();
        if (!id) return failResult("Workspace is not mounted on this server.", "/mcp");
        return mapResult(
          await request<{
            items: Array<{ name: string; disabledByTools?: boolean; managedOAuth?: { status?: string } | null }>;
          }>(`${workspacePath(id)}/mcp`, {
            method: "POST",
            body: { name: params.name, config: params.config },
            timeoutMs: 30_000,
          }),
          (data) => buildMcpStatus(data.items),
        );
      },

      async connect(params: { name: string; directory?: string }): Promise<EngineResult<Record<string, never>>> {
        const id = workspaceId();
        if (!id) return failResult("Workspace is not mounted on this server.", "/mcp");
        return await request<Record<string, never>>(
          `${workspacePath(id)}/mcp/${encodeURIComponent(params.name)}/managed/connect`,
          { method: "POST", timeoutMs: 60_000 },
        );
      },

      async disconnect(params: { name: string; directory?: string }): Promise<EngineResult<Record<string, never>>> {
        const id = workspaceId();
        if (!id) return failResult("Workspace is not mounted on this server.", "/mcp");
        return await request<Record<string, never>>(
          `${workspacePath(id)}/mcp/${encodeURIComponent(params.name)}`,
          { method: "DELETE", timeoutMs: 30_000 },
        );
      },

      auth: {
        async remove(params: { name: string; directory?: string }): Promise<EngineResult<Record<string, never>>> {
          const id = workspaceId();
          if (!id) return failResult("Workspace is not mounted on this server.", "/mcp");
          return await request<Record<string, never>>(
            `${workspacePath(id)}/mcp/${encodeURIComponent(params.name)}/auth`,
            { method: "DELETE", timeoutMs: 30_000 },
          );
        },
        async authenticate(params: { name: string; directory?: string }): Promise<EngineResult<EngineMcpServerStatus>> {
          return mapResult(
            await client.mcp.status({ directory: params.directory }),
            (statuses) => statuses[params.name] ?? { status: "needs_auth" },
          );
        },
        async start(params: { name: string; directory?: string }): Promise<EngineResult<{ authorizationUrl?: string }>> {
          const id = workspaceId();
          if (!id) return failResult("Workspace is not mounted on this server.", "/mcp");
          return mapResult(
            await request<{ status?: string; authorizeUrl?: string }>(
              `${workspacePath(id)}/mcp/${encodeURIComponent(params.name)}/managed/connect`,
              { method: "POST", timeoutMs: 60_000 },
            ),
            (data) => ({ ...(data.authorizeUrl ? { authorizationUrl: data.authorizeUrl } : {}) }),
          );
        },
        async callback(params: {
          name: string;
          directory?: string;
          code?: string;
        }): Promise<EngineResult<EngineMcpServerStatus>> {
          return client.mcp.auth.authenticate({ name: params.name, directory: params.directory });
        },
      },
    },

    config: {
      async get(params: { directory?: string } = {}): Promise<EngineResult<Config>> {
        void params;
        const id = workspaceId();
        if (!id) return failResult("Workspace is not mounted on this server.", "/config");
        const result = await request<{ engine: Config }>(`${workspacePath(id)}/config`);
        if (!result.ok) return result;
        const config = result.data.engine;
        const runtime = await request<{ runtime?: { disabled_providers?: unknown } }>(
          `${workspacePath(id)}/runtime-config`,
        );
        if (runtime.ok && Array.isArray(runtime.data.runtime?.disabled_providers)) {
          config.disabled_providers = runtime.data.runtime.disabled_providers.filter(
            (provider): provider is string => typeof provider === "string",
          );
        }
        return {
          ok: true,
          data: config,
          error: undefined,
          request: result.request,
          response: result.response,
        };
      },

      async update(params: { directory?: string; config: Config }): Promise<EngineResult<Config>> {
        const id = workspaceId();
        if (!id) return failResult("Workspace is not mounted on this server.", "/config");
        return mapResult(
          await request<{ engine?: Config }>(`${workspacePath(id)}/config`, {
            method: "PATCH",
            body: { engine: params.config },
            timeoutMs: 30_000,
          }),
          (data) => data.engine ?? params.config,
        );
      },
    },

    command: {
      async list(params: { directory?: string } = {}): Promise<EngineResult<Array<Record<string, unknown>>>> {
        void params;
        const id = workspaceId();
        if (!id) return failResult("Workspace is not mounted on this server.", "/commands");
        return mapResult(
          await request<{ items: Array<Record<string, unknown>> }>(`${workspacePath(id)}/commands`),
          (data) => data.items,
        );
      },
    },

    app: {
      async agents(params: { directory?: string } = {}): Promise<EngineResult<Agent[]>> {
        void params;
        return okResult<Agent[]>([]);
      },
    },

    find: {
      async files(params: {
        query: string;
        dirs?: string;
        limit?: number;
        directory?: string;
      }): Promise<EngineResult<string[]>> {
        const id = workspaceId();
        if (!id) return failResult("Select a workspace to find files.", "/files/search");
        const query = new URLSearchParams({ query: params.query, limit: String(params.limit ?? 50) });
        return mapResult(
          await request<{ items: string[] }>(`${workspacePath(id)}/files/search?${query}`),
          (data) => data.items,
        );
      },
    },

    lsp: {
      async status(params: { directory?: string } = {}): Promise<EngineResult<LspStatus[]>> {
        void params;
        return okResult<LspStatus[]>([]);
      },
    },

    vcs: {
      async get(params: { directory?: string } = {}): Promise<EngineResult<VcsInfo | null>> {
        void params;
        return okResult<VcsInfo | null>(null);
      },
    },

    project: {
      async list(): Promise<EngineResult<Project[]>> {
        return okResult<Project[]>([]);
      },
    },

    path: {
      async get(): Promise<EngineResult<{ directory: string }>> {
        return okResult({ directory: options.directory ?? "" });
      },
    },

    auth: {
      async set(params: {
        providerID: string;
        auth: { type: string; key?: string };
      }): Promise<EngineResult<Record<string, never>>> {
        const id = workspaceId();
        if (!id) return failResult("Workspace is not mounted on this server.", "/codex/auth");
        return await request<Record<string, never>>(
          `${workspacePath(id)}/codex/auth/${encodeURIComponent(params.providerID)}`,
          { method: "PUT", body: { key: params.auth.key ?? "" }, timeoutMs: 30_000 },
        );
      },
      async remove(params: { providerID: string }): Promise<EngineResult<Record<string, never>>> {
        const id = workspaceId();
        if (!id) return failResult("Workspace is not mounted on this server.", "/codex/auth");
        return await request<Record<string, never>>(
          `${workspacePath(id)}/codex/auth/${encodeURIComponent(params.providerID)}`,
          { method: "DELETE", timeoutMs: 30_000 },
        );
      },
    },

    instance: {
      async dispose(): Promise<EngineResult<Record<string, never>>> {
        const id = workspaceId();
        if (!id) return failResult("Workspace is not mounted on this server.", "/engine/reload");
        return await request<Record<string, never>>(`${workspacePath(id)}/engine/reload`, {
          method: "POST",
          timeoutMs: 60_000,
        });
      },
    },

    permission: {
      async list(params: { directory?: string } = {}): Promise<EngineResult<PermissionRequest[]>> {
        void params;
        return okResult<PermissionRequest[]>([]);
      },
      async reply(params: {
        requestID: string;
        reply: "once" | "always" | "reject";
        directory?: string;
      }): Promise<EngineResult<Record<string, never>>> {
        void params;
        return okResult<Record<string, never>>({});
      },
    },

    question: {
      async list(params: { directory?: string } = {}): Promise<EngineResult<QuestionRequest[]>> {
        void params;
        return okResult<QuestionRequest[]>([]);
      },
      async reply(params: {
        requestID: string;
        answers: string[][];
        directory?: string;
      }): Promise<EngineResult<Record<string, never>>> {
        void params;
        return okResult<Record<string, never>>({});
      },
    },

    v2: {
      session: {
        permission: {
          async list(params: { sessionID: string }): Promise<EngineResult<{ data: PermissionV2Request[] }>> {
            void params;
            return okResult({ data: [] });
          },
          async reply(params: {
            sessionID: string;
            requestID: string;
            reply: "once" | "always" | "reject";
          }): Promise<EngineResult<Record<string, never>>> {
            void params;
            return okResult<Record<string, never>>({});
          },
        },
      },
    },
  };

  return client;
}

export type EngineClient = ReturnType<typeof createEngineClient>;

export function createWorkspaceEngineClient(options: EngineClientOptions) {
  return createEngineClient(options);
}
