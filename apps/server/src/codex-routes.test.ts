// Minimal route-level verification for /codex/* endpoints (additive proof).
import { describe, it, expect, beforeEach } from "bun:test";
import { registerCodexRoutes } from "./codex-routes.js";
import { addRoute, matchRoute, type RequestContext, type Route } from "./routes/registry.js";

const routes: { method: string; regex: RegExp; keys: string[]; auth: string; handler: Function }[] = [];

function fakeRegistry() {
  return {
    getOrCreate: async () => ({
      engineInfo: { bin: "/fake/codex" },
      listSessions: () => [{ id: "codex-t1", threadId: "t1", title: "x", status: "idle", created: "2025-01-01", turnId: null, workspaceId: "w1" }],
      createSession: async () => ({ id: "codex-t2", threadId: "t2", title: "y", status: "idle", created: "2025-01-01", turnId: null, workspaceId: "w1" }),
      prompt: async () => ({ id: "codex-t2", threadId: "t2", title: "y", status: "running", created: "2025-01-01", turnId: "turn-1", workspaceId: "w1" }),
      abort: async () => {},
      delete: async () => {},
      forkSession: async () => ({ id: "codex-fork", threadId: "fork", title: "x", status: "idle", created: "2025-01-01", turnId: null, workspaceId: "w1" }),
      listBackgroundProcesses: async () => [],
      terminateBackgroundProcess: async () => false,
      cleanBackgroundProcesses: async () => {},
      on: () => () => {},
    }),
  };
}

describe("codex routes", () => {
  beforeEach(() => { routes.length = 0; });
  it("registers 6 routes", () => {
    registerCodexRoutes({
      routes: routes as any,
      config: { host: "127.0.0.1", port: 0, token: "t", workspaces: [] } as any,
      readJsonBody: async (r) => ({}),
      requireClientScope: () => {},
      ensureWritable: () => {},
      registry: fakeRegistry() as any,
    });
    expect(routes.length).toBeGreaterThanOrEqual(6);
  });

  it("forwards image inputs from the request body to prompt and steer", async () => {
    const calls: Array<{ method: string; text: string; images?: string[] }> = [];
    const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
    const session = { id: "codex-t1", threadId: "t1", title: "x", status: "idle" as const, created: "2025-01-01", turnId: null, workspaceId: "w1" };
    const manager = {
      engineInfo: {},
      start: async () => {},
      listSessions: () => [session],
      createSession: async () => session,
      prompt: async (_sessionId: string, text: string, opts?: { images?: string[] }) => {
        calls.push({ method: "prompt", text, images: opts?.images });
        return session;
      },
      steer: async (_sessionId: string, text: string, images?: string[]) => {
        calls.push({ method: "steer", text, images });
        return session;
      },
      abort: async () => {},
      delete: async () => {},
      setArchived: async () => session,
      rename: async () => session,
      getSessionItems: async () => [],
      getTurnChanges: async () => [],
      forkSession: async () => session,
      listBackgroundProcesses: async () => [],
      terminateBackgroundProcess: async () => false,
      cleanBackgroundProcesses: async () => {},
      on: () => () => {},
    };

    const typedRoutes: Route[] = [];
    registerCodexRoutes({
      routes: typedRoutes,
      config: { host: "127.0.0.1", port: 0, token: "t", workspaces: [] } as unknown as import("./types.js").ServerConfig,
      readJsonBody: async (request) => (await request.json()) as Record<string, unknown>,
      requireClientScope: () => {},
      ensureWritable: () => {},
      registry: { getOrCreate: async () => manager },
    });

    const invoke = async (path: string, body: Record<string, unknown>) => {
      const matched = matchRoute(typedRoutes, "POST", path);
      if (!matched) throw new Error(`route not registered: ${path}`);
      return await matched.handler({
        request: new Request(`http://127.0.0.1${path}`, { method: "POST", body: JSON.stringify(body) }),
        url: new URL(`http://127.0.0.1${path}`),
        params: matched.params,
      } as unknown as RequestContext);
    };

    // Non-string and blank entries are dropped before reaching the engine.
    await invoke("/workspace/ws_1/codex/sessions/codex-t1/prompt", { text: "look", images: [image, 7, "  "] });
    await invoke("/workspace/ws_1/codex/sessions/codex-t1/steer", { text: "more", images: [image] });

    expect(calls).toEqual([
      { method: "prompt", text: "look", images: [image] },
      { method: "steer", text: "more", images: [image] },
    ]);
  });
});
