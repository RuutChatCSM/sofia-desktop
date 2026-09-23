import path from "node:path";
import { expect } from "vitest";
import { test } from "@sofia/testkit";
import { CodexSessionManager, type CodexSession } from "../../apps/server/src/codex-sessions.ts";
import { registerCodexRoutes, type CodexSessionRegistry } from "../../apps/server/src/codex-routes.ts";
import { matchRoute, type Route } from "../../apps/server/src/routes/registry.ts";
import { ApprovalService } from "../../apps/server/src/approvals.ts";
import { ReloadEventStore } from "../../apps/server/src/events.ts";
import { TokenService } from "../../apps/server/src/tokens.ts";
import type { ServerConfig } from "../../apps/server/src/types.ts";
import { resolveSofiaRelease } from "../../apps/desktop/electron/sofia-release.mjs";

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
