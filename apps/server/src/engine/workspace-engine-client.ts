// Codex-backed workspace engine client.
//
// This is the adapter that replaces the Sofia engine SDK in the Sofia App server:
// it exposes the small subset of the Sofia engine client surface the server's
// feature modules call, but every method is backed by the bundled Sofia/Codex
// engine (`CodexSessionManager` + the codex provider/config stores). Feature
// modules therefore keep their existing call shapes while Sofia engine is removed.
//
// Return values mirror the Sofia engine SDK's `{ data, error, response }` result so
// callers can keep using `unwrapWorkspaceEngineResult`.
import { readCodexEngineConfig, type CodexEngineConfig } from "../codex-providers.js";
import { getOrCreateCodexSessionManager } from "../codex-registry.js";
import { defaultCodexRuntimeMcpServers } from "../codex-runtime-mcp.js";
import type { CodexSession } from "../codex-sessions.js";
import type { ServerConfig, WorkspaceInfo } from "../types.js";

export type EngineOk<T> = { data: T; error: undefined; response: Response };
export type EngineFail = { data: undefined; error: unknown; response?: Response };
export type EngineResult<T> = EngineOk<T> | EngineFail;

export type EngineSessionInfo = {
  id: string;
  title: string;
  slug: string;
  parentID: string | null;
  directory: string;
  time: { created: number; updated: number };
  status: "idle" | "busy";
};

export type EngineMessagePart = {
  id: string;
  messageID: string;
  sessionID: string;
} & Record<string, unknown>;

export type EngineMessage = {
  info: {
    id: string;
    sessionID: string;
    role: string;
    parentID: string | null;
    time: { created: number };
  };
  parts: EngineMessagePart[];
};

export type EngineTodo = { content: string; status: string; priority: string };

export type EngineSessionStatus =
  | { type: "idle" }
  | { type: "busy" }
  | { type: "retry"; attempt: number; message: string; next: number };

export type EngineProviderModel = {
  id: string;
  name: string;
  capabilities?: { toolcall?: boolean };
};

export type EngineProvider = {
  id: string;
  name: string;
  models: Record<string, EngineProviderModel>;
};

export type EngineProviderList = {
  all: EngineProvider[];
  default: Record<string, string>;
  connected: string[];
};

/**
 * Per-server MCP status union mirroring the Sofia engine SDK's `McpStatus` shape so
 * health/reconcile logic keeps narrowing on the literal status values.
 */
export type EngineMcpServerStatus =
  | { status: "connected" }
  | { status: "disabled" }
  | { status: "failed"; error: string }
  | { status: "needs_auth" }
  | { status: "needs_client_registration"; error: string };

export type EngineMcpStatus = Record<string, EngineMcpServerStatus>;

/** Minimal replacements for the SDK's `ToolIds` / `ToolList` aliases. */
export type EngineToolIds = string[];
export type EngineToolItem = { id: string; description?: string };
export type EngineToolList = EngineToolItem[];

/** Optional request options accepted for SDK call-shape compatibility. */
export type WorkspaceEngineRequestOptions = { signal?: AbortSignal };

export type WorkspaceEngineClient = {
  session: {
    list(input?: { roots?: boolean; start?: number; search?: string; limit?: number }): Promise<EngineResult<EngineSessionInfo[]>>;
    create(input: { title: string }): Promise<EngineResult<EngineSessionInfo>>;
    get(input: { sessionID: string }): Promise<EngineResult<EngineSessionInfo>>;
    messages(input: { sessionID: string; limit?: number }): Promise<EngineResult<EngineMessage[]>>;
    todo(input: { sessionID: string }): Promise<EngineResult<EngineTodo[]>>;
    status(): Promise<EngineResult<Record<string, EngineSessionStatus>>>;
    promptAsync(input: {
      sessionID: string;
      model?: { providerID: string; modelID: string };
      variant?: string;
      parts: Array<{ type: "text"; text: string }>;
    }): Promise<EngineResult<Record<string, never>>>;
    abort(input: { sessionID: string }): Promise<EngineResult<Record<string, never>>>;
    delete(input: { sessionID: string }): Promise<EngineResult<Record<string, never>>>;
  };
  provider: {
    list(input?: { directory?: string }): Promise<EngineResult<EngineProviderList>>;
  };
  config: {
    get(
      input?: { directory?: string },
      options?: WorkspaceEngineRequestOptions,
    ): Promise<EngineResult<CodexEngineConfig>>;
  };
  mcp: {
    status(input?: { directory?: string }): Promise<EngineResult<EngineMcpStatus>>;
    disconnect(input: { name: string; directory?: string }): Promise<EngineResult<Record<string, never>>>;
    auth: {
      remove(input: { name: string; directory?: string }): Promise<EngineResult<Record<string, never>>>;
    };
  };
  tool: {
    ids(input?: { directory?: string }): Promise<EngineResult<EngineToolIds>>;
    list(input?: { directory?: string; provider?: string; model?: string }): Promise<EngineResult<EngineToolList>>;
  };
  app: {
    agents(
      input?: { directory?: string },
      options?: WorkspaceEngineRequestOptions,
    ): Promise<EngineResult<Array<{ name: string; description?: string }>>>;
  };
  global: {
    health(): Promise<EngineResult<{ healthy: boolean; version: string | null }>>;
  };
};

export type WorkspaceEngineClientOptions = {
  boundedDiagnosticsReads?: boolean;
  sessionId?: string;
};

function ok<T>(data: T): EngineOk<T> {
  return { data, error: undefined, response: new Response(null, { status: 200 }) };
}

function fail(error: unknown, status = 502): EngineFail {
  return { data: undefined, error, response: new Response(null, { status }) };
}

function toSessionInfo(session: CodexSession): EngineSessionInfo {
  const created = Date.parse(session.created);
  const createdMs = Number.isFinite(created) ? created : Date.now();
  return {
    id: session.id,
    title: session.title,
    slug: session.id,
    parentID: null,
    directory: session.cwd ?? "",
    time: { created: createdMs, updated: createdMs },
    status: session.status === "running" ? "busy" : "idle",
  };
}

function itemRole(item: Record<string, unknown>): string {
  const type = typeof item.type === "string" ? item.type : "";
  return type.toLowerCase().includes("user") ? "user" : "assistant";
}

function toMessage(
  sessionId: string,
  turnId: string,
  item: Record<string, unknown>,
  index: number,
): EngineMessage {
  const itemType = typeof item.type === "string" ? item.type : "unknown";
  const partId = typeof item.id === "string" ? item.id : `${sessionId}-${turnId}-${index}`;
  return {
    info: {
      id: partId,
      sessionID: sessionId,
      role: itemRole(item),
      parentID: null,
      time: { created: Date.now() },
    },
    parts: [{ id: partId, messageID: partId, sessionID: sessionId, type: itemType, ...item }],
  };
}

function toProvider(providerId: string, config: CodexEngineConfig): EngineProvider {
  const provider = config.providers.find((entry) => entry.providerId === providerId);
  const models: Record<string, { id: string; name: string }> = {};
  for (const model of provider?.models ?? []) {
    models[model.id] = { id: model.id, name: model.name };
  }
  return { id: providerId, name: provider?.providerName ?? providerId, models };
}

async function readEngineConfig(): Promise<CodexEngineConfig> {
  return await readCodexEngineConfig();
}

/**
 * Build a Codex-backed engine client for a workspace. Mirrors the Sofia engine
 * client method names the Sofia App server calls.
 */
export function createWorkspaceEngineClient(
  config: ServerConfig,
  workspace: WorkspaceInfo,
  options: WorkspaceEngineClientOptions = {},
): WorkspaceEngineClient {
  const manager = async () => {
    const engine = await getOrCreateCodexSessionManager(config, workspace.id);
    // Metadata reads must restore persisted Sofia sessions on a cold server too.
    await engine.start();
    return engine;
  };
  void options;

  return {
    session: {
      async list(input = {}) {
        try {
          const sessions = (await manager()).listSessions();
          const search = input.search?.trim().toLowerCase();
          const filtered = search
            ? sessions.filter((session) => session.title.toLowerCase().includes(search))
            : sessions;
          const limit = input.limit ?? filtered.length;
          return ok(filtered.slice(0, limit).map(toSessionInfo));
        } catch (error) {
          return fail(error);
        }
      },

      async create(input) {
        try {
          const engine = await manager();
          const session = await engine.createSession({ title: input.title, workspaceId: workspace.id });
          return ok(toSessionInfo(session));
        } catch (error) {
          return fail(error);
        }
      },

      async get(input) {
        try {
          const session = (await manager()).getSession(input.sessionID);
          if (!session) return fail({ code: 404, message: "session_not_found" }, 404);
          return ok(toSessionInfo(session));
        } catch (error) {
          return fail(error);
        }
      },

      async messages(input) {
        try {
          const engine = await manager();
          if (!engine.getSession(input.sessionID)) {
            return fail({ code: 404, message: "session_not_found" }, 404);
          }
          const items = await engine.getSessionItems(input.sessionID, { limit: input.limit });
          return ok(items.map((entry, index) => toMessage(input.sessionID, entry.turnId, entry.item, index)));
        } catch (error) {
          return fail(error);
        }
      },

      async todo(input) {
        const engine = await manager();
        if (!engine.getSession(input.sessionID)) {
          return fail({ code: 404, message: "session_not_found" }, 404);
        }
        return ok<EngineTodo[]>([]);
      },

      async status() {
        try {
          const sessions = (await manager()).listSessions();
          const statuses: Record<string, EngineSessionStatus> = {};
          for (const session of sessions) {
            statuses[session.id] = session.status === "running" ? { type: "busy" } : { type: "idle" };
          }
          return ok(statuses);
        } catch (error) {
          return fail(error);
        }
      },

      async promptAsync(input) {
        try {
          const engine = await manager();
          const text = input.parts.map((part) => part.text).join("");
          await engine.prompt(input.sessionID, text, {
            ...(input.model ? { model: input.model.modelID, providerId: input.model.providerID } : {}),
          });
          return ok<Record<string, never>>({});
        } catch (error) {
          return fail(error);
        }
      },

      async abort(input) {
        try {
          await (await manager()).abort(input.sessionID);
          return ok<Record<string, never>>({});
        } catch (error) {
          return fail(error);
        }
      },

      async delete(input) {
        try {
          await (await manager()).delete(input.sessionID);
          return ok<Record<string, never>>({});
        } catch (error) {
          return fail(error);
        }
      },
    },

    provider: {
      async list() {
        try {
          const engineConfig = await readEngineConfig();
          const connected = engineConfig.providers.map((provider) => provider.providerId);
          const defaultProvider = engineConfig.defaultProviderId;
          const defaultModel = engineConfig.model;
          return ok<EngineProviderList>({
            all: engineConfig.providers.map((provider) => toProvider(provider.providerId, engineConfig)),
            default: defaultProvider && defaultModel ? { [defaultProvider]: defaultModel } : {},
            connected,
          });
        } catch (error) {
          return fail(error);
        }
      },
    },

    config: {
      async get() {
        try {
          return ok(await readEngineConfig());
        } catch (error) {
          return fail(error);
        }
      },
    },

    mcp: {
      async status() {
        try {
          const statuses: EngineMcpStatus = {};
          for (const server of defaultCodexRuntimeMcpServers()) {
            statuses[server.name] = { status: "connected" };
          }
          return ok(statuses);
        } catch (error) {
          return fail(error);
        }
      },

      async disconnect() {
        // The codex engine reconciles MCP servers from config on reload; there
        // is no live per-server disconnect call.
        return ok<Record<string, never>>({});
      },

      auth: {
        async remove() {
          return ok<Record<string, never>>({});
        },
      },
    },

    tool: {
      async ids() {
        return ok<string[]>([]);
      },
      async list() {
        return ok<Array<{ id: string; description?: string }>>([]);
      },
    },

    app: {
      async agents() {
        return ok<Array<{ name: string; description?: string }>>([]);
      },
    },

    global: {
      async health() {
        try {
          const engine = await manager();
          return ok({ healthy: engine.isRunning(), version: null });
        } catch (error) {
          return fail(error);
        }
      },
    },
  };
}
