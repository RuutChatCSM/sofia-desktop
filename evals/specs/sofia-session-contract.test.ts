import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect } from "vitest";
import { test } from "@sofia/testkit";
import { CodexSessionManager, CodexThreadBusyError, type CodexSession } from "../../apps/server/src/codex-sessions.ts";
import { registerCodexRoutes, type CodexSessionRegistry } from "../../apps/server/src/codex-routes.ts";
import type { EngineResult, EngineSessionInfo, WorkspaceEngineClient } from "../../apps/server/src/engine/workspace-engine-client.ts";
import { ApiError } from "../../apps/server/src/errors.ts";
import { registerSessionRoutes } from "../../apps/server/src/routes/sessions.ts";
import { matchRoute, type Route } from "../../apps/server/src/routes/registry.ts";
import { ApprovalService } from "../../apps/server/src/approvals.ts";
import { ReloadEventStore } from "../../apps/server/src/events.ts";
import { TokenService } from "../../apps/server/src/tokens.ts";
import type { ServerConfig, WorkspaceInfo } from "../../apps/server/src/types.ts";
import { resolveSofiaRelease } from "../../apps/desktop/electron/sofia-release.mjs";

const fixtureEngine = path.resolve(import.meta.dirname, "../fixtures/sofia-engine.mjs");

function fixtureManager(env: Record<string, string>): CodexSessionManager {
  return new CodexSessionManager({ bin: fixtureEngine, interpreter: process.execPath, cwd: process.cwd(), env }, "ws");
}

function readCalls(logPath: string): string[] {
  try {
    return readFileSync(logPath, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

function engineOk<T>(data: T): EngineResult<T> {
  return { data, error: undefined, response: new Response(null, { status: 200 }) };
}

function unwrapEngineResult<T>(result: EngineResult<T>, requestPath: string): NonNullable<T> {
  if (result.data != null) return result.data;
  throw new ApiError(502, "engine_request_failed", `engine error for ${requestPath}`);
}

function sessionInfo(directory: string): EngineSessionInfo {
  return { id: "codex-abc", title: "Imported task", slug: "codex-abc", parentID: null, directory, time: { created: 1, updated: 2 }, status: "idle" };
}

function sessionEngineClient(directory: () => string): WorkspaceEngineClient {
  return {
    session: {
      async list() { return engineOk<EngineSessionInfo[]>([]); },
      async create() { return engineOk(sessionInfo(directory())); },
      async get() { return engineOk(sessionInfo(directory())); },
      async messages() { return engineOk([]); },
      async todo() { return engineOk([]); },
      async status() { return engineOk({}); },
      async promptAsync() { return engineOk({}); },
      async abort() { return engineOk({}); },
      async delete() { return engineOk({}); },
    },
    provider: { async list() { return engineOk({ all: [], default: {}, connected: [] }); } },
    config: { async get() { return engineOk({ defaultProviderId: null, model: null, providers: [] }); } },
    mcp: {
      async status() { return engineOk({}); },
      async disconnect() { return engineOk({}); },
      auth: { async remove() { return engineOk({}); } },
    },
    tool: {
      async ids() { return engineOk([]); },
      async list() { return engineOk([]); },
    },
    app: { async agents() { return engineOk([]); } },
    global: { async health() { return engineOk({ healthy: true, version: null }); } },
  };
}

test("Sofia tasks round-trip native rename, archive and interrupt, isolate workspaces and preserve failed deletions", async () => {
  const manager = new CodexSessionManager({
    bin: path.resolve(import.meta.dirname, "../fixtures/sofia-engine.mjs"),
    interpreter: process.execPath, cwd: process.cwd(),
  }, "ws");
  try {
    await manager.start();
    expect(manager.listSessions().map((s) => s.title)).toEqual(["Persisted title"]);
    expect(manager.listSessions()[0].created).toBe("2023-11-14T22:13:20.000Z");
    const session = await manager.createSession({ title: "Task", workspaceId: "ws" });
    expect((await manager.rename(session.id, "Renamed task")).title).toBe("Renamed task");
    expect((await manager.setArchived(session.id, true)).archived).toBe(true);
    expect((await manager.setArchived(session.id, false)).archived).toBe(false);
    await manager.prompt(session.id, "Implement the requested change");
    expect(manager.getSession(session.id)?.status).toBe("running");
    await manager.abort(session.id);
    expect(manager.getSession(session.id)?.status).toBe("idle");
    await expect(manager.delete(session.id)).rejects.toThrow("delete rejected");
    expect(manager.getSession(session.id)?.title).toBe("Renamed task");
  } finally { await manager.close(); }
});

test("Sofia archive/rename routes enforce write scope and stream cancellation releases its subscription", async () => {
  const routes: Route[] = [];
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "client", hostToken: "host",
    approval: { mode: "manual", timeoutMs: 1000 }, corsOrigins: [], workspaces: [], authorizedRoots: [],
    readOnly: false, startedAt: 0, tokenSource: "generated", hostTokenSource: "generated", logFormat: "pretty", logRequests: false,
  };
  let session: CodexSession = { id: "codex-one", threadId: "one", title: "Original", workspaceId: "ws", created: "2026-01-01", status: "idle", turnId: null };
  let subscriptions = 0, scopes = 0;
  const registry: CodexSessionRegistry = { getOrCreate: async () => ({
    engineInfo: {}, start: async () => {}, listSessions: () => [session],
    createSession: async () => session, prompt: async () => session, abort: async () => {}, delete: async () => {},
    getSessionItems: async () => [],
    setArchived: async (_, archived) => (session = { ...session, archived }),
    rename: async (_, title) => (session = { ...session, title }),
    on: () => { subscriptions++; return () => { subscriptions--; }; },
  }) };
  registerCodexRoutes({ routes, config, registry,
    readJsonBody: (request) => request.json(),
    requireClientScope: (_, scope) => { expect(scope).toBe("collaborator"); scopes++; },
    ensureWritable: (value) => { if (value.readOnly) throw new Error("read only"); },
  });
  async function request(method: string, suffix: string, body?: unknown) {
    const url = new URL(`http://localhost/workspace/ws/codex/${suffix}`);
    const route = matchRoute(routes, method, url.pathname);
    if (!route) throw new Error(`missing route ${url.pathname}`);
    return route.handler({ request: new Request(url, { method, body: body ? JSON.stringify(body) : undefined }),
      url, params: route.params, config, approvals: new ApprovalService(config.approval), reloadEvents: new ReloadEventStore(), tokens: new TokenService(config) });
  }
  expect((await (await request("POST", "sessions/codex-one/archive", { archived: true })).json()).session.archived).toBe(true);
  expect((await (await request("POST", "sessions/codex-one/rename", { title: "New name" })).json()).session.title).toBe("New name");
  await request("POST", "sessions/codex-one/abort");
  await request("DELETE", "sessions/codex-one");
  expect(scopes).toBe(4);
  await expect(request("POST", "sessions/codex-one/archive", { archived: "yes" })).rejects.toThrow("boolean");
  const stream = await request("GET", "stream");
  expect(subscriptions).toBe(1);
  await stream.body?.cancel();
  expect(subscriptions).toBe(0);
  config.readOnly = true;
  await expect(request("POST", "sessions/codex-one/rename", { title: "Blocked" })).rejects.toThrow("read only");
});

test("Sofia releases are opt-in and cannot target upstream repositories", () => {
  expect(resolveSofiaRelease().stable).toBe("");
  expect(() => resolveSofiaRelease({ repository: "RuutChatCSM/sofia-desktop" })).toThrow("Sofia-owned");
  expect(() => resolveSofiaRelease({ repository: "openai/codex" })).toThrow("Sofia-owned");
  expect(resolveSofiaRelease({ repository: "example/sofia" }).stable).toBe("https://github.com/example/sofia/releases/latest/download");
});

test("Reading a Sofia transcript never resumes the thread, so browsing cannot lock it", async () => {
  const logPath = path.join(mkdtempSync(path.join(tmpdir(), "sofia-transcript-")), "calls.log");
  const manager = fixtureManager({ SOFIA_FIXTURE_LOG: logPath });
  try {
    await manager.start();
    expect(await manager.getSessionItems("codex-local")).toEqual([]);
    const calls = readCalls(logPath);
    expect(calls).toContain("thread/items/list");
    expect(calls).not.toContain("thread/resume");
    expect(calls).not.toContain("thread/unsubscribe");
  } finally { await manager.close(); }
});

test("A Sofia turn on a thread this process already loaded proceeds and releases it when idle", async () => {
  const logPath = path.join(mkdtempSync(path.join(tmpdir(), "sofia-loaded-")), "calls.log");
  const manager = fixtureManager({ SOFIA_FIXTURE_LOG: logPath, SOFIA_FIXTURE_LOADED: "local" });
  try {
    await manager.start();
    const session = await manager.prompt("codex-local", "Implement the requested change");
    expect(session.status).toBe("running");
    await manager.abort(session.id);
    expect(manager.getSession(session.id)?.status).toBe("idle");
    const calls = readCalls(logPath);
    expect(calls).toContain("thread/resume");
    expect(calls).toContain("thread/unsubscribe");
  } finally { await manager.close(); }
});

test("A Sofia task whose thread another process holds fails with an actionable message", async () => {
  const logPath = path.join(mkdtempSync(path.join(tmpdir(), "sofia-held-")), "calls.log");
  const manager = fixtureManager({ SOFIA_FIXTURE_LOG: logPath, SOFIA_FIXTURE_WRITER_HELD: "local" });
  try {
    await manager.start();
    await expect(manager.prompt("codex-local", "Implement the requested change"))
      .rejects.toThrow(/open elsewhere/i);
    expect(manager.getSession("codex-local")?.status).toBe("error");
  } finally { await manager.close(); }
});

test("Sofia session reads resolve imported sessions that carry no directory", async () => {
  const routes: Route[] = [];
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "client", hostToken: "host",
    approval: { mode: "manual", timeoutMs: 1000 }, corsOrigins: [], workspaces: [], authorizedRoots: [],
    readOnly: false, startedAt: 0, tokenSource: "generated", hostTokenSource: "generated", logFormat: "pretty", logRequests: false,
  };
  const workspace: WorkspaceInfo = { id: "ws", name: "ws", path: "/repo", preset: "starter", workspaceType: "local", baseUrl: "http://127.0.0.1:1" };
  let directory = "";
  registerSessionRoutes({
    routes, config,
    jsonResponse: (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } }),
    parseOptionalBoolean: () => undefined,
    parseOptionalPositiveInteger: () => undefined,
    parseOptionalNonNegativeInteger: () => undefined,
    readJsonBody: async () => ({}),
    ensureWritable: () => {},
    requireClientScope: () => {},
    resolveWorkspace: async () => workspace,
    resolveWorkspaceWithoutBootstrap: async () => workspace,
    resolveWorkspaceEngineDirectory: () => workspace.path,
    createWorkspaceWorkspaceEngineClient: () => sessionEngineClient(() => directory),
    unwrapWorkspaceEngineResult: unwrapEngineResult,
  });
  async function readSession() {
    const url = new URL("http://localhost/workspace/ws/sessions/codex-abc");
    const route = matchRoute(routes, "GET", url.pathname);
    if (!route) throw new Error(`missing route ${url.pathname}`);
    return route.handler({ request: new Request(url), url, params: route.params, config,
      approvals: new ApprovalService(config.approval), reloadEvents: new ReloadEventStore(), tokens: new TokenService(config) });
  }
  expect(await (await readSession()).json()).toMatchObject({ item: { directory: "" } });
  directory = "/repo/apps/server";
  expect(await (await readSession()).json()).toMatchObject({ item: { directory: "/repo/apps/server" } });
  directory = "/somewhere/else";
  await expect(readSession()).rejects.toMatchObject({ code: "session_not_found", status: 404 });
});

test("Sofia reports a task held by another process as a conflict the app can explain", async () => {
  const routes: Route[] = [];
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "client", hostToken: "host",
    approval: { mode: "manual", timeoutMs: 1000 }, corsOrigins: [], workspaces: [], authorizedRoots: [],
    readOnly: false, startedAt: 0, tokenSource: "generated", hostTokenSource: "generated", logFormat: "pretty", logRequests: false,
  };
  const session: CodexSession = { id: "codex-one", threadId: "one", title: "Held task", workspaceId: "ws", created: "2026-01-01", status: "idle", turnId: null };
  const registry: CodexSessionRegistry = { getOrCreate: async () => ({
    engineInfo: {}, start: async () => {}, listSessions: () => [session],
    createSession: async () => session,
    prompt: async () => { throw new CodexThreadBusyError("one"); },
    abort: async () => {}, delete: async () => {},
    getSessionItems: async () => [],
    setArchived: async () => session, rename: async () => session,
    on: () => () => {},
  }) };
  registerCodexRoutes({ routes, config, registry,
    readJsonBody: (request) => request.json(),
    requireClientScope: () => {},
    ensureWritable: () => {},
  });
  const url = new URL("http://localhost/workspace/ws/codex/sessions/codex-one/prompt");
  const route = matchRoute(routes, "POST", url.pathname);
  if (!route) throw new Error(`missing route ${url.pathname}`);
  await expect(route.handler({
    request: new Request(url, { method: "POST", body: JSON.stringify({ text: "ping" }) }),
    url, params: route.params, config,
    approvals: new ApprovalService(config.approval), reloadEvents: new ReloadEventStore(), tokens: new TokenService(config),
  })).rejects.toMatchObject({
    status: 409,
    code: "thread_writer_conflict",
    message: expect.stringContaining("open elsewhere"),
  });
});
