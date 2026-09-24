import { chmod, copyFile, mkdir, mkdtemp, realpath, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect } from "vitest";
import { test } from "@sofia/testkit";
import { CodexSessionManager } from "../../apps/server/src/codex-sessions.ts";
import { codexBinaryForConfig, closeCodexManagersForConfig, getOrCreateCodexSessionManager, setCodexBinaryForConfig } from "../../apps/server/src/codex-registry.ts";
import type { ServerConfig, WorkspaceInfo } from "../../apps/server/src/types.ts";
import { registerSessionRoutes } from "../../apps/server/src/routes/sessions.ts";
import { matchRoute, type Route } from "../../apps/server/src/routes/registry.ts";
import { createWorkspaceEngineClient } from "../../apps/server/src/engine/workspace-engine-client.ts";
import { ApprovalService } from "../../apps/server/src/approvals.ts";
import { ReloadEventStore } from "../../apps/server/src/events.ts";
import { TokenService } from "../../apps/server/src/tokens.ts";
import { resolveSofiaEngine } from "../../apps/desktop/electron/sofia-engine.mjs";

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "sofia-lifecycle-")));
  const bin = join(root, "sofia");
  await copyFile(resolve(import.meta.dirname, "../fixtures/sofia-lifecycle.mjs"), bin);
  await chmod(bin, 0o755);
  await writeFile(join(root, "config.toml"), '[model_providers.deepseek]\nname = "DeepSeek"\n');
  await writeFile(join(root, "legacy.jsonl"), "");
  const manager = new CodexSessionManager({ bin, cwd: root, codexHome: root, env: { HOME: join(root, "unrelated-home") } }, "ws");
  const requests = async (): Promise<Array<{ method: string; params: Record<string, unknown> }>> =>
    (await readFile(join(root, "requests.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  return { root, bin, manager, requests, close: async () => { await manager.close(); await rm(root, { recursive: true, force: true }); } };
}

test("Sofia uses its pinned home and resumes persisted and imported tasks before prompting", async () => {
  const f = await fixture();
  try {
    await f.manager.start();
    expect(f.manager.engineInfo.codexHome).toBe(f.root);
    expect(f.manager.engineInfo.userAgent).toBe("sofia");
    const fresh = await f.manager.createSession({ title: "Fresh", workspaceId: "ws", providerId: "deepseek", model: "model" });
    await f.manager.prompt(fresh.id, "First message");
    expect((await f.requests()).filter((r) => r.method === "thread/resume")).toHaveLength(0);
    await f.manager.prompt("codex-saved", "Continue", { providerId: "deepseek", model: "model" });
    await f.manager.prompt("codex-legacy", "Continue imported task", { providerId: "deepseek", model: "model" });
    const calls = await f.requests();
    const saved = calls.filter((r) => r.params.threadId === "saved");
    expect(saved.map((r) => r.method)).toEqual(["thread/resume", "thread/settings/update", "turn/start"]);
    expect(saved[0].params.modelProvider).toBe("deepseek");
    expect(calls.filter((r) => r.method === "thread/resume" && r.params.threadId === "legacy")[1].params.path).toBe(join(f.root, "legacy.jsonl"));
    expect(calls.filter((r) => r.method === "thread/start")).toHaveLength(1);
    expect(f.manager.getSession("codex-legacy")?.threadId).toBe("legacy");
  } finally { await f.close(); }
});

test("Sofia preserves resume errors, unlocks failed turns and resumes again after restart", async () => {
  const f = await fixture();
  try {
    await expect(f.manager.prompt("codex-bad-provider", "Hello")).rejects.toThrow("Model provider `missing` not found");
    expect(f.manager.getSession("codex-bad-provider")?.status).toBe("error");
    expect((await f.requests()).some((r) => r.method === "turn/start")).toBe(false);
    await expect(f.manager.prompt("codex-reject-turn", "Hello")).rejects.toThrow("turn rejected by provider");
    await expect(f.manager.prompt("codex-reject-turn", "Retry")).rejects.toThrow("turn rejected by provider");
    expect(f.manager.getSession("codex-reject-turn")?.status).toBe("error");
    await f.manager.getSessionItems("codex-saved");
    await f.manager.close();
    await f.manager.prompt("codex-saved", "After restart");
    expect(f.manager.getSession("codex-saved")?.status).toBe("running");
    expect((await f.requests()).filter((r) => r.method === "thread/resume" && r.params.threadId === "saved")).toHaveLength(2);
  } finally { await f.close(); }
});

test("Sofia provider refresh keeps engine registration, active turns and stream subscribers", async () => {
  const f = await fixture();
  const env = { SOFIA_HOME: f.root, SOFIA_PROVIDER_HOME: f.root, HOME: f.root, REAL_HOME: f.root };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "client", hostToken: "host", approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: [], workspaces: [{ id: "ws", name: "Test", path: f.root, workspaceType: "local" }], authorizedRoots: [],
    readOnly: false, startedAt: 0, tokenSource: "generated", hostTokenSource: "generated", logFormat: "pretty", logRequests: false,
  };
  try {
    Object.assign(process.env, env);
    setCodexBinaryForConfig(config, { path: f.bin, source: "custom" });
    const manager = await getOrCreateCodexSessionManager(config, "ws");
    await manager.start();
    const pid = manager.engineInfo.pid;
    let events = 0;
    const off = manager.on(() => events++);
    await writeFile(join(f.root, "providers.json"), JSON.stringify({ providers: { deepseek: {
      name: "DeepSeek", base_url: "http://localhost", wire_api: "chatcompletions", api_key: "test-only",
      models: [{ id: "test", name: "Test", reasoning: false }],
    } } }));
    const refreshed = await getOrCreateCodexSessionManager(config, "ws");
    expect(refreshed).toBe(manager);
    const session = await refreshed.createSession({ title: "Provider connected", workspaceId: "ws", providerId: "deepseek", prompt: "Hello" });
    const managers = await Promise.all(Array.from({ length: 12 }, () => getOrCreateCodexSessionManager(config, "ws")));
    expect(managers.every((value) => value === manager)).toBe(true);
    expect(codexBinaryForConfig(config)?.path).toBe(f.bin);
    expect(manager.engineInfo.pid).toBe(pid);
    expect(manager.getSession(session.id)?.status).toBe("running");
    expect(events).toBeGreaterThan(0);
    expect(await readFile(join(f.root, "config.toml"), "utf8")).toContain("[model_providers.deepseek]");
    off();
  } finally {
    await closeCodexManagersForConfig(config);
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await f.close();
  }
});

test("Sofia binary selection honors explicit and development settings without requiring CDP", async () => {
  const root = await mkdtemp(join(tmpdir(), "sofia-resolution-"));
  try {
    const sidecars = join(root, "sidecars"), installed = join(root, "bin");
    await mkdir(sidecars); await mkdir(installed);
    await writeFile(join(sidecars, "sofia"), ""); await writeFile(join(installed, "sofia"), "");
    const options = { home: root, platform: "darwin", sidecarDirs: [sidecars] };
    expect(resolveSofiaEngine({ ...options, env: { SOFIA_BIN: "/explicit/sofia", PATH: installed } })?.path).toBe("/explicit/sofia");
    expect(resolveSofiaEngine({ ...options, env: { PATH: installed } })?.path).toBe(join(sidecars, "sofia"));
    expect(resolveSofiaEngine({ ...options, sidecarDirs: [], env: { PATH: installed } })?.path).toBe(join(installed, "sofia"));
    expect(resolveSofiaEngine({ ...options, env: { SOFIA_DEV_ENGINE: "1", PATH: installed } })?.path).toBe(join(sidecars, "sofia"));
    expect(resolveSofiaEngine({ ...options, env: { SOFIA_DEV_ENGINE: "1", PATH: installed }, sidecarDirs: [] })).toBeNull();
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("Sofia generic session reads restore tasks on cold start and reject missing tasks", async () => {
  const f = await fixture();
  const env = { SOFIA_HOME: f.root, SOFIA_PROVIDER_HOME: f.root, HOME: f.root, REAL_HOME: f.root };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  const workspace: WorkspaceInfo = { id: "ws", name: "Test", path: f.root, workspaceType: "local", preset: "starter" };
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "client", hostToken: "host", approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: [], workspaces: [workspace], authorizedRoots: [], readOnly: false, startedAt: 0,
    tokenSource: "generated", hostTokenSource: "generated", logFormat: "pretty", logRequests: false,
  };
  try {
    Object.assign(process.env, env);
    setCodexBinaryForConfig(config, { path: f.bin, source: "custom" });
    const routes: Route[] = [];
    registerSessionRoutes({
      routes, config, jsonResponse: (data, status = 200) => Response.json(data, { status }),
      parseOptionalBoolean: () => undefined, parseOptionalPositiveInteger: () => undefined, parseOptionalNonNegativeInteger: () => undefined,
      readJsonBody: (request) => request.json(), ensureWritable: () => {}, requireClientScope: () => {},
      resolveWorkspace: async () => workspace, resolveWorkspaceWithoutBootstrap: async () => workspace,
      resolveWorkspaceEngineDirectory: () => f.root, createWorkspaceWorkspaceEngineClient: createWorkspaceEngineClient,
      unwrapWorkspaceEngineResult: (result) => { if (result.data === undefined) throw new Error("Session not found"); return result.data; },
    });
    async function request(suffix: string) {
      const url = new URL(`http://localhost/workspace/ws/sessions/${suffix}`);
      const route = matchRoute(routes, "GET", url.pathname);
      if (!route) throw new Error("missing route");
      return route.handler({ request: new Request(url), url, params: route.params, config,
        approvals: new ApprovalService(config.approval), reloadEvents: new ReloadEventStore(), tokens: new TokenService(config) });
    }
    const details = await request("codex-saved");
    expect(details.status).toBe(200);
    expect((await details.json()).item.id).toBe("codex-saved");
    expect((await request("codex-saved/messages")).status).toBe(200);
    const snapshot = await request("codex-saved/snapshot");
    expect(snapshot.status).toBe(200);
    expect((await snapshot.json()).item.session.id).toBe("codex-saved");
    await expect(request("codex-missing")).rejects.toThrow("Session not found");
  } finally {
    await closeCodexManagersForConfig(config);
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await f.close();
  }
});
