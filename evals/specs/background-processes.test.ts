import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect } from "vitest";
import { test } from "@sofia/testkit";

import { CodexSessionManager, shouldNotifyBackgroundProcessFailure, type BackgroundProcess, type BackgroundProcessStatus, type CodexEvent } from "../../apps/server/src/codex-sessions.ts";
import { CodexAttentionHub, type CodexAttentionEvent } from "../../apps/server/src/codex-attention.ts";
import {
  backgroundProcessFailureTitle,
  refreshBackgroundProcesses,
  runCodexStream,
  setCodexClient,
  useCodexSessionStore,
} from "../../apps/app/src/react-app/domains/session/codex-session-store.ts";
import { codexItemToToolPart } from "../../apps/app/src/react-app/domains/session/sync/codex-item-translator.ts";
import { registerCodexRoutes, type CodexSessionRegistry } from "../../apps/server/src/codex-routes.ts";
import { matchRoute, type Route } from "../../apps/server/src/routes/registry.ts";
import { ApprovalService } from "../../apps/server/src/approvals.ts";
import { ReloadEventStore } from "../../apps/server/src/events.ts";
import { TokenService } from "../../apps/server/src/tokens.ts";
import type { ServerConfig } from "../../apps/server/src/types.ts";

const fixtureEngine = path.resolve(import.meta.dirname, "../fixtures/sofia-engine.mjs");

function readCalls(logPath: string): string[] {
  try {
    return readFileSync(logPath, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting for condition");
}

function backgroundManager(logPath: string): CodexSessionManager {
  return new CodexSessionManager(
    {
      bin: fixtureEngine,
      interpreter: process.execPath,
      cwd: process.cwd(),
      env: {
        SOFIA_FIXTURE_LOG: logPath,
        SOFIA_FIXTURE_BACKGROUND_TERMINAL: "1",
        // The engine can complete a turn before the turn/start reply lands;
        // that is exactly the sequence that must not drop the subscription.
        SOFIA_FIXTURE_COMPLETE_BEFORE_START_REPLY: "1",
      },
    },
    "ws",
  );
}

test("Sofia keeps a thread resident while a background process is live, then releases it on exit", async () => {
  const logPath = path.join(mkdtempSync(path.join(tmpdir(), "sofia-bg-lifecycle-")), "calls.log");
  const manager = backgroundManager(logPath);
  try {
    const session = await manager.createSession({ title: "Dev server", workspaceId: "ws" });
    const events: string[] = [];
    manager.on((event) => events.push(event.type));
    await manager.prompt(session.id, "start the dev server");
    await waitFor(() => events.includes("turn.completed"));

    // The turn ended, but the process it started still owns the thread: dropping
    // the subscription now is what let the engine unload and kill it.
    expect(readCalls(logPath).filter((method) => method === "thread/unsubscribe")).toHaveLength(0);
    expect(events).toContain("backgroundProcesses");

    // Reconcile: the server registry and the engine's live list agree.
    const live: BackgroundProcess[] = await manager.listBackgroundProcesses(session.id);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({
      itemId: "call-bg-1",
      processId: "1234",
      command: "pnpm dev",
      status: "running",
    });

    // Stopping the last process makes the thread unload-eligible again.
    await expect(manager.terminateBackgroundProcess(session.id, "1234")).resolves.toBe(true);
    await waitFor(() => readCalls(logPath).includes("thread/unsubscribe"));

    const exited = await manager.listBackgroundProcesses(session.id);
    expect(exited).toHaveLength(1);
    expect(exited[0].status).toBe("completed");
    expect(exited[0].exitCode).toBe(0);
  } finally {
    await manager.close();
  }
});

test("Sofia stop-all clears every background process and releases the thread", async () => {
  const logPath = path.join(mkdtempSync(path.join(tmpdir(), "sofia-bg-clean-")), "calls.log");
  const manager = backgroundManager(logPath);
  try {
    const session = await manager.createSession({ title: "Dev server", workspaceId: "ws" });
    const events: string[] = [];
    manager.on((event) => events.push(event.type));
    await manager.prompt(session.id, "start the dev server");
    await waitFor(() => events.includes("turn.completed"));
    expect((await manager.listBackgroundProcesses(session.id)).filter((p) => p.status === "running")).toHaveLength(1);

    await manager.cleanBackgroundProcesses(session.id);
    expect(readCalls(logPath)).toContain("thread/backgroundTerminals/clean");
    await waitFor(() => readCalls(logPath).includes("thread/unsubscribe"));
    expect((await manager.listBackgroundProcesses(session.id)).some((p) => p.status === "running")).toBe(false);
  } finally {
    await manager.close();
  }
});

const routeConfig: ServerConfig = {
  host: "127.0.0.1",
  port: 0,
  token: "client",
  hostToken: "host",
  approval: { mode: "auto", timeoutMs: 1000 },
  corsOrigins: [],
  workspaces: [],
  authorizedRoots: [],
  readOnly: false,
  startedAt: 0,
  tokenSource: "generated",
  hostTokenSource: "generated",
  logFormat: "pretty",
  logRequests: false,
};

test("Sofia background-process routes proxy list/terminate/clean and stay write-scoped", async () => {
  const routes: Route[] = [];
  const calls: string[] = [];
  const live: BackgroundProcess[] = [
    { itemId: "call-bg-1", processId: "1234", command: "pnpm dev", status: "running" },
  ];
  let scopes = 0;
  const registry: CodexSessionRegistry = {
    getOrCreate: async () => ({
      engineInfo: {},
      start: async () => {},
      listSessions: () => [],
      createSession: async () => { throw new Error("unused"); },
      prompt: async () => { throw new Error("unused"); },
      steer: async () => { throw new Error("unused"); },
      abort: async () => {},
      delete: async () => {},
      setArchived: async () => { throw new Error("unused"); },
      rename: async () => { throw new Error("unused"); },
      getSessionItems: async () => [],
      listBackgroundProcesses: async (sessionId) => { calls.push(`list:${sessionId}`); return live; },
      terminateBackgroundProcess: async (sessionId, processId) => {
        calls.push(`terminate:${sessionId}:${processId}`);
        return processId === "1234";
      },
      cleanBackgroundProcesses: async (sessionId) => { calls.push(`clean:${sessionId}`); },
      on: () => () => {},
    }),
  };
  registerCodexRoutes({
    routes,
    config: routeConfig,
    registry,
    readJsonBody: (request) => request.json() as Promise<Record<string, unknown>>,
    requireClientScope: (_, scope) => { expect(scope).toBe("collaborator"); scopes++; },
    ensureWritable: (config) => { if (config.readOnly) throw new Error("read only"); },
  });

  async function request(method: string, suffix: string) {
    const url = new URL(`http://localhost/workspace/ws/codex/${suffix}`);
    const route = matchRoute(routes, method, url.pathname);
    if (!route) throw new Error(`missing route ${method} ${url.pathname}`);
    return route.handler({
      request: new Request(url, { method }),
      url,
      params: route.params,
      config: routeConfig,
      approvals: new ApprovalService(routeConfig.approval),
      reloadEvents: new ReloadEventStore(),
      tokens: new TokenService(routeConfig),
    });
  }

  const listed = await (await request("GET", "sessions/codex-one/background-processes")).json();
  expect(listed.processes).toEqual(live);
  const terminated = await (await request("POST", "sessions/codex-one/background-processes/1234/terminate")).json();
  expect(terminated.terminated).toBe(true);
  await request("POST", "sessions/codex-one/background-processes/clean");
  expect(calls).toEqual([
    "list:codex-one",
    "terminate:codex-one:1234",
    "clean:codex-one",
  ]);
  expect(scopes).toBe(2);

  routeConfig.readOnly = true;
  await expect(request("POST", "sessions/codex-one/background-processes/1234/terminate")).rejects.toThrow("read only");
  routeConfig.readOnly = false;
});

test("Sofia store takes the server registry as authoritative on open and over the stream", async () => {
  const live: BackgroundProcess[] = [
    { itemId: "call-bg-1", processId: "1234", command: "pnpm dev", status: "running" },
  ];
  const client = {
    backgroundProcesses: async () => ({ ok: true, processes: live }),
    stream: async (signal: AbortSignal, onEvent: (event: unknown) => void) => {
      onEvent({ type: "stream.ready", streamId: "s1" });
      onEvent({ type: "backgroundProcesses", sessionId: "codex-t1", threadId: "t1", processes: live });
      await Promise.resolve();
      void signal;
    },
  };
  const store = useCodexSessionStore.getState();
  store.clear();
  store.replaceSessions([
    { id: "codex-t1", threadId: "t1", title: "x", workspaceId: "ws", created: "2026-01-01", turnId: null, status: "idle" },
  ]);
  setCodexClient("ws", client as never);
  try {
    // Session open reconciles from the server.
    await refreshBackgroundProcesses("codex-t1");
    expect(useCodexSessionStore.getState().sessions["codex-t1"]?.backgroundProcesses).toEqual(live);

    // A stale local view is replaced by the streamed frame.
    useCodexSessionStore.getState().setBackgroundProcesses("codex-t1", []);
    const controller = new AbortController();
    const streamed = runCodexStream(client as never, controller.signal, undefined, "ws");
    await waitFor(() => useCodexSessionStore.getState().sessions["codex-t1"]?.backgroundProcesses.length === 1);
    controller.abort();
    await streamed;
  } finally {
    setCodexClient("ws", null);
    useCodexSessionStore.getState().clear();
  }
});

test("unified exec startup translates to a background process item, not an ordinary shell call", () => {
  const background = codexItemToToolPart(
    { id: "bg", type: "commandExecution", command: "pnpm dev", source: "unifiedExecStartup", processId: "1234", status: "inProgress" },
    "session",
    "message",
  );
  expect(background).toMatchObject({ toolName: "background_process", state: "input-streaming" });
  // A plain agent shell call keeps the existing bash rendering.
  const shell = codexItemToToolPart(
    { id: "cmd", type: "commandExecution", command: "ls", source: "agent", status: "completed" },
    "session",
    "message",
    true,
  );
  expect(shell).toMatchObject({ toolName: "bash", state: "output-available" });
});

test("Sofia only pings the user when a background resource outlives its turn and dies", () => {
  const base = { itemId: "call-bg-1", processId: "1234", command: "pnpm dev" };
  const notify = (process: typeof base & { status: BackgroundProcessStatus; exitCode?: number }, turnRunning: boolean) =>
    shouldNotifyBackgroundProcessFailure({ process, turnRunning });

  // A finite command's exit code is a result, not an attention state: `grep`
  // returning 1 mid-turn must not raise "Needs you"...
  expect(notify({ ...base, status: "completed", exitCode: 1 }, true)).toBe(false);
  // ...while a process that actually dies still pages, whenever that happens.
  expect(notify({ ...base, status: "failed" }, true)).toBe(true);
  expect(notify({ ...base, status: "declined" }, true)).toBe(true);

  // A resource that outlives its turn pages for a non-zero exit too, because
  // nobody else is left to act on it.
  expect(notify({ ...base, status: "failed" }, false)).toBe(true);
  expect(notify({ ...base, status: "completed", exitCode: 1 }, false)).toBe(true);
  // ...while a clean exit never does.
  expect(notify({ ...base, status: "completed", exitCode: 0 }, false)).toBe(false);
  expect(notify({ ...base, status: "running" }, false)).toBe(false);

  expect(backgroundProcessFailureTitle({ ...base, status: "completed", exitCode: 1 })).toContain("exited with code 1");
});

test("Sofia observes a background-process failure cross-workspace, once, with replay until acked", async () => {
  const logPath = path.join(mkdtempSync(path.join(tmpdir(), "sofia-bg-attention-")), "calls.log");
  const manager = new CodexSessionManager(
    {
      bin: fixtureEngine,
      interpreter: process.execPath,
      cwd: process.cwd(),
      env: {
        SOFIA_FIXTURE_LOG: logPath,
        SOFIA_FIXTURE_BACKGROUND_TERMINAL: "1",
        SOFIA_FIXTURE_BACKGROUND_TERMINAL_FAIL: "1",
        SOFIA_FIXTURE_COMPLETE_BEFORE_START_REPLY: "1",
      },
    },
    "ws",
  );
  const hub = new CodexAttentionHub();
  // Observing the same workspace twice must not double-deliver.
  hub.observe("ws", manager);
  hub.observe("ws", manager);
  const received: CodexAttentionEvent[] = [];
  const off = hub.on((event) => received.push(event));
  try {
    const session = await manager.createSession({ title: "Dev server", workspaceId: "ws" });
    await manager.prompt(session.id, "start the dev server");
    await waitFor(() => received.length >= 1);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      type: "backgroundProcess.failed",
      sessionId: session.id,
      threadId: session.threadId,
      workspaceId: "ws",
      itemId: "call-bg-1",
      processId: "1234",
      command: "pnpm dev",
      exitCode: 1,
    });
    // The event is pending until a renderer acknowledges it, so a failure that
    // happens while no window is listening is not lost.
    expect(hub.pendingEvents()).toHaveLength(1);
    hub.acknowledge({ sessionId: session.id, itemId: "call-bg-1" });
    expect(hub.pendingEvents()).toHaveLength(0);
  } finally {
    off();
    await manager.close();
  }
});

function attentionTestRegistry(): CodexSessionRegistry {
  const notUsed = async (): Promise<never> => { throw new Error("unused"); };
  return {
    getOrCreate: async () => ({
      engineInfo: {},
      start: async () => {},
      listSessions: () => [],
      createSession: notUsed,
      prompt: notUsed,
      steer: notUsed,
      abort: async () => {},
      delete: async () => {},
      setArchived: notUsed,
      rename: notUsed,
      getSessionItems: async () => [],
      forkSession: notUsed,
      listBackgroundProcesses: async () => [],
      terminateBackgroundProcess: async () => false,
      cleanBackgroundProcesses: async () => {},
      on: () => () => {},
    }),
  };
}

test("Sofia attention routes replay pending events and acknowledge them", async () => {
  const routes: Route[] = [];
  const hub = new CodexAttentionHub();
  const listeners: Array<(event: CodexEvent) => void> = [];
  hub.observe("ws", { on: (listener) => { listeners.push(listener); return () => {}; } });
  const event: CodexAttentionEvent = {
    type: "backgroundProcess.failed",
    sessionId: "codex-one",
    threadId: "one",
    workspaceId: "ws",
    sessionTitle: "Dev server",
    itemId: "call-bg-1",
    processId: "1234",
    command: "pnpm dev",
    exitCode: 1,
  };
  for (const listener of listeners) listener(event);
  expect(hub.pendingEvents()).toHaveLength(1);

  registerCodexRoutes({
    routes,
    config: routeConfig,
    attention: hub,
    registry: attentionTestRegistry(),
    readJsonBody: (request) => request.json() as Promise<Record<string, unknown>>,
    requireClientScope: () => {},
    ensureWritable: () => {},
  });

  const context = (url: URL, method: string, body?: unknown) => ({
    request: new Request(url, { method, ...(body ? { body: JSON.stringify(body) } : {}) }),
    url,
    params: {},
    config: routeConfig,
    approvals: new ApprovalService(routeConfig.approval),
    reloadEvents: new ReloadEventStore(),
    tokens: new TokenService(routeConfig),
  });

  const streamUrl = new URL("http://localhost/codex/attention");
  const streamRoute = matchRoute(routes, "GET", streamUrl.pathname);
  expect(streamRoute).not.toBeNull();
  const response = await streamRoute!.handler(context(streamUrl, "GET"));
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (let page = 0; page < 3 && !text.includes("call-bg-1"); page += 1) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += decoder.decode(chunk.value);
  }
  expect(text).toContain("stream.ready");
  expect(text).toContain("backgroundProcess.failed");
  expect(text).toContain("call-bg-1");
  await reader.cancel();

  const ackUrl = new URL("http://localhost/codex/attention/ack");
  const ackRoute = matchRoute(routes, "POST", ackUrl.pathname);
  expect(ackRoute).not.toBeNull();
  const ackResponse = await ackRoute!.handler(context(ackUrl, "POST", { sessionId: "codex-one", itemId: "call-bg-1" }));
  expect(await ackResponse.json()).toEqual({ ok: true });
  expect(hub.pendingEvents()).toHaveLength(0);

  await expect(ackRoute!.handler(context(ackUrl, "POST", {}))).rejects.toThrow("required");
});
