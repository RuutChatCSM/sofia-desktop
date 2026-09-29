import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { CodexSessionManager, codexSessionId, isCodexSessionId, isMissingRolloutError, isThreadWriterConflict, threadBelongsToWorkspace, threadTitleFromEngineText, resolveRevertBoundary, THREAD_TITLE_MAX_LENGTH } from "./codex-sessions.js";

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
});

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "sofia-codex-sessions-"));
  roots.push(root);
  return root;
}

/** Methods the fake engine was asked for, in order. */
function readCallLog(path: string): string[] {
  try {
    return readFileSync(path, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

type FakeCodexOptions = {
  /** Append every requested method here so tests can assert what was called. */
  logPath?: string;
  /** Append every turn input (prompt/steer) here so tests can assert its shape. */
  inputLogPath?: string;
  /** Append every `thread/settings/update` payload so tests can assert the pair. */
  settingsLogPath?: string;
  /** `thread/items/list` payload (materialized store items). */
  items?: unknown[];
  /** Paged `thread/items/list` payloads, oldest first; each links to the next. */
  itemsPages?: Array<{ data: unknown[]; nextCursor?: string | null }>;
  /** `thread/list` payload (threads restored into the session map). */
  threads?: unknown[];
  /** `thread/read` payloads keyed by thread id. */
  readThreads?: Record<string, unknown>;
  /** `thread/loaded/list` payload (threads loaded in this engine process). */
  loadedThreads?: string[];
  /** Make `thread/resume` fail the way a competing writer does. */
  resumeConflict?: boolean;
};

async function writeFakeCodex(
  root: string,
  notifications: Array<{ method: string; params: Record<string, unknown> }> = [],
  options: FakeCodexOptions = {},
): Promise<string> {
  const path = join(root, "codex.js");
  await writeFile(path, [
    "import { createInterface } from 'node:readline';",
    "import { appendFileSync } from 'node:fs';",
    "if (process.argv.includes('--version')) {",
    "  process.stdout.write('codex-cli 0.149.1\\n');",
    "  process.exit(0);",
    "}",
    "const rl = createInterface({ input: process.stdin });",
    "const notifications = " + JSON.stringify(notifications) + ";",
    "const logPath = " + JSON.stringify(options.logPath ?? null) + ";",
    "const inputLogPath = " + JSON.stringify(options.inputLogPath ?? null) + ";",
    "const settingsLogPath = " + JSON.stringify(options.settingsLogPath ?? null) + ";",
    "const listItems = " + JSON.stringify(options.items ?? []) + ";",
    "const itemPages = " + JSON.stringify(options.itemsPages ?? []) + ";",
    "const listedThreads = " + JSON.stringify(options.threads ?? []) + ";",
    "const readThreads = " + JSON.stringify(options.readThreads ?? {}) + ";",
    "const loadedThreads = " + JSON.stringify(options.loadedThreads ?? []) + ";",
    "const resumeConflict = " + JSON.stringify(options.resumeConflict === true) + ";",
    "const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');",
    "let id = 0;",
    "function emitNotifications(threadId, turnId) {",
    "  for (const n of notifications) {",
    "    send({ jsonrpc: '2.0', method: n.method, params: { threadId, turnId, ...n.params } });",
    "  }",
    "}",
    "rl.on('line', (line) => {",
    "  if (!line.trim()) return;",
    "  let msg;",
    "  try { msg = JSON.parse(line); } catch { return; }",
    "  if (logPath) appendFileSync(logPath, msg.method + '\\n');",
    "  if (msg.method === 'initialize') {",
    "    send({ jsonrpc: '2.0', id: msg.id, result: { userAgent: 'fake-codex', codexHome: '/tmp/fake-codex-home' } });",
    "  } else if (msg.method === 'thread/start') {",
    "    const threadId = 'thread-' + (++id);",
    "    send({ jsonrpc: '2.0', id: msg.id, result: { threadId } });",
    "    emitNotifications(threadId, null);",
    "  } else if (msg.method === 'turn/start') {",
    "    const turnId = 'turn-' + (++id);",
    "    const threadId = msg.params.threadId;",
    "    if (inputLogPath) appendFileSync(inputLogPath, JSON.stringify(msg.params.input) + '\\n');",
    "    send({ jsonrpc: '2.0', id: msg.id, result: { threadId, turnId } });",
    "    // Stream a fake agent message delta, then complete the turn — unless the",
    "    // input asks to hold it open (so tests can steer an in-flight turn).",
    "    const hold = JSON.stringify(msg.params.input ?? '').includes('hold');",
    "    setTimeout(() => {",
    "      send({ jsonrpc: '2.0', method: 'item/started', params: { threadId, itemType: 'agentMessage' } });",
    "      send({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { threadId, delta: 'hello from codex' } });",
    "      send({ jsonrpc: '2.0', method: 'item/completed', params: { threadId, itemType: 'agentMessage' } });",
    "      emitNotifications(threadId, turnId);",
    "      if (!hold) send({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId, turnId } });",
    "    }, 30);",
    "  } else if (msg.method === 'thread/fork') {",
    "    send({ jsonrpc: '2.0', id: msg.id, result: { threadId: 'forked-' + (++id) } });",
    "  } else if (msg.method === 'turn/steer') {",
    "    const steerText = JSON.stringify(msg.params.input ?? '');",
    "    if (inputLogPath) appendFileSync(inputLogPath, JSON.stringify(msg.params.input) + '\\n');",
    "    if (steerText.includes('steer-no-active')) {",
    "      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32600, message: 'no active turn to steer' } });",
    "    } else if (steerText.includes('steer-not-steerable')) {",
    "      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32600, message: 'cannot steer a review turn' } });",
    "    } else {",
    "      send({ jsonrpc: '2.0', id: msg.id, result: { turnId: 'steered-' + (++id) } });",
    "    }",
    "  } else if (msg.method === 'thread/list') {",
    "    send({ jsonrpc: '2.0', id: msg.id, result: { data: listedThreads } });",
    "  } else if (msg.method === 'thread/loaded/list') {",
    "    send({ jsonrpc: '2.0', id: msg.id, result: { data: loadedThreads } });",
    "  } else if (msg.method === 'thread/items/list') {",
    "    if (itemPages.length === 0) {",
    "      send({ jsonrpc: '2.0', id: msg.id, result: { data: listItems } });",
    "    } else {",
    "      const requested = msg.params.cursor ?? null;",
    "      const page = itemPages.find((p, i) => (i === 0 ? requested === null : requested === itemPages[i - 1].nextCursor));",
    "      send({ jsonrpc: '2.0', id: msg.id, result: { data: page?.data ?? [], nextCursor: page?.nextCursor ?? null } });",
    "    }",
    "  } else if (msg.method === 'thread/read') {",
    "    send({ jsonrpc: '2.0', id: msg.id, result: readThreads[msg.params.threadId] ?? {} });",
    "  } else if (msg.method === 'thread/resume') {",
    "    if (resumeConflict) {",
    "      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32600, message: 'thread ' + msg.params.threadId + ' already has an active writer' } });",
    "    } else {",
    "      send({ jsonrpc: '2.0', id: msg.id, result: {} });",
    "    }",
    "  } else if (msg.method === 'thread/settings/update') {",
    "    if (settingsLogPath) appendFileSync(settingsLogPath, JSON.stringify(msg.params) + '\\n');",
    "    send({ jsonrpc: '2.0', id: msg.id, result: {} });",
    "  } else if (msg.method === 'thread/archive' || msg.method === 'thread/unarchive' || msg.method === 'thread/unsubscribe' || msg.method === 'turn/interrupt') {",
    "    send({ jsonrpc: '2.0', id: msg.id, result: {} });",
    "  } else {",
    "    send({ jsonrpc: '2.0', id: msg.id, result: {} });",
    "  }",
    "});",
    "process.on('SIGTERM', () => process.exit(0));",
  ].join("\n"));
  await chmod(path, 0o755);
  return path;
}

describe("CodexSessionManager", () => {
  test("creates a codex session id and round-trips it", () => {
    expect(codexSessionId("thread-1")).toBe("codex-thread-1");
    expect(isCodexSessionId("codex-thread-1")).toBe(true);
    expect(isCodexSessionId("engine-session-1")).toBe(false);
  });

  test("createSession + prompt streams deltas and completes the turn", async () => {
    const root = await createRoot();
    const bin = await writeFakeCodex(root);
    const manager = new CodexSessionManager({ bin, cwd: root, interpreter: process.execPath });

    const events: string[] = [];
    manager.on((event) => events.push(event.type));

    try {
      const session = await manager.createSession({
        title: "Test",
        workspaceId: "ws_1",
        model: "mimo-v2.5",
        providerId: "xiaomi",
      });
      expect(session.threadId).toMatch(/^thread-/);
      expect(session.id).toBe(codexSessionId(session.threadId));
      expect(session.model).toBe("mimo-v2.5");
      expect(session.providerId).toBe("xiaomi");
      expect(manager.listSessions()).toHaveLength(1);

      await manager.prompt(session.id, "hi");
      expect(manager.getSession(session.id)?.status).toBe("running");

      const deadline = Date.now() + 2000;
      while (Date.now() < deadline && !events.includes("turn.completed")) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      expect(events).toContain("session.created");
      expect(events).toContain("message.delta");
      expect(events).toContain("turn.completed");
      expect(session.status).toBe("idle");
    } finally {
      await manager.close();
    }
  });

  test("isRunning and engineInfo reflect the engine lifecycle", async () => {
    const root = await createRoot();
    const bin = await writeFakeCodex(root);
    const manager = new CodexSessionManager({ bin, cwd: root, interpreter: process.execPath });
    expect(manager.isRunning()).toBe(false);
    try {
      await manager.createSession({ title: "T", workspaceId: "ws_1" });
      expect(manager.isRunning()).toBe(true);
      expect(manager.engineInfo.running).toBe(true);
    } finally {
      await manager.close();
      expect(manager.isRunning()).toBe(false);
    }
  });

  test("prompt and steer send images as structured inputs, never as base64 prompt text", async () => {
    const root = await createRoot();
    const inputLogPath = join(root, "inputs.log");
    const bin = await writeFakeCodex(root, [], { inputLogPath });
    const manager = new CodexSessionManager({ bin, cwd: root, interpreter: process.execPath });
    const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
    try {
      const session = await manager.createSession({ title: "T", workspaceId: "ws_1", cwd: root });

      // "hold" keeps the turn in flight so steer is available right after.
      await manager.prompt(session.id, "describe this hold", { images: [image] });
      const lines = readFileSync(inputLogPath, "utf8").trim().split("\n");
      const promptInput = JSON.parse(lines[0] ?? "[]") as Array<Record<string, unknown>>;
      expect(promptInput).toContainEqual({ type: "image", url: image });
      const promptText = promptInput.filter((entry) => entry.type === "text").map((entry) => entry.text).join("");
      expect(promptText).toContain("describe this hold");
      expect(promptText).not.toContain("iVBORw0KGgo");
      expect(promptText).not.toContain("data:image");

      await manager.steer(session.id, "and this one", [image]);
      const steerLines = readFileSync(inputLogPath, "utf8").trim().split("\n");
      const steerInput = JSON.parse(steerLines[steerLines.length - 1] ?? "[]") as Array<Record<string, unknown>>;
      expect(steerInput).toContainEqual({ type: "image", url: image });
    } finally {
      await manager.close();
    }
  });

  test("RPC parity: steer, fork, archive, unsubscribe at the session level", async () => {
    const root = await createRoot();
    const bin = await writeFakeCodex(root);
    const manager = new CodexSessionManager({ bin, cwd: root, interpreter: process.execPath });
    try {
      const session = await manager.createSession({ title: "T", workspaceId: "ws_1", cwd: root });
      expect(session.cwd).toBe(root);

      // Start a turn that stays in flight so turn/steer has an active turn.
      await manager.prompt(session.id, "hold");
      const steered = await manager.steer(session.id, "go on");
      expect(steered.turnId).toMatch(/^steered-/);
      expect(manager.getSession(session.id)?.status).toBe("running");

      const forked = await manager.forkSession(session.id);
      expect(forked.id).toBe(codexSessionId(forked.threadId));
      expect(forked.threadId).toMatch(/^forked-/);
      expect(manager.listSessions()).toHaveLength(2);

      const archived = await manager.setArchived(session.id, true);
      expect(archived.archived).toBe(true);
      const unarchived = await manager.setArchived(session.id, false);
      expect(unarchived.archived).toBe(false);

      await expect(manager.unsubscribeSession(session.id)).resolves.toBeUndefined();
    } finally {
      await manager.close();
    }
  });

  test("isMissingRolloutError detects the codex no-rollout failure", () => {
    expect(isMissingRolloutError(new Error("codex rpc error (-32600): no rollout found for thread id 01abc"))).toBe(true);
    expect(isMissingRolloutError(new Error("some other failure"))).toBe(false);
  });

  test("isThreadWriterConflict detects the engine's exclusive-writer rejection", () => {
    expect(isThreadWriterConflict(new Error("thread 01abc already has an active writer"))).toBe(true);
    expect(isThreadWriterConflict(new Error("codex rpc error (-32600): thread 01abc already has an active writer"))).toBe(true);
    expect(isThreadWriterConflict(new Error("no rollout found for thread id 01abc"))).toBe(false);
  });

  test("getSessionItems reads the store without resuming (no writer lock)", async () => {
    const root = await createRoot();
    const logPath = join(root, "calls.log");
    const bin = await writeFakeCodex(root, [], {
      logPath,
      items: [
        { turnId: "turn-1", item: { type: "userMessage", id: "u1", content: [{ type: "text", text: "hi" }] } },
        { turnId: "turn-1", item: { type: "agentMessage", id: "a1", text: "hello" } },
      ],
    });
    const manager = new CodexSessionManager({ bin, cwd: root, interpreter: process.execPath });
    try {
      const session = await manager.createSession({ title: "T", workspaceId: "ws_1", cwd: root });
      const items = await manager.getSessionItems(session.id);

      expect(items).toHaveLength(2);
      expect(items[1].item).toMatchObject({ type: "agentMessage", text: "hello" });
      // Resuming here would claim the thread's exclusive writer lock for the
      // lifetime of this process, locking every other Sofia process out.
      expect(readCallLog(logPath)).not.toContain("thread/resume");
    } finally {
      await manager.close();
    }
  });

  test("prompt tolerates a competing writer when the thread is already loaded here", async () => {
    const root = await createRoot();
    const logPath = join(root, "calls.log");
    const bin = await writeFakeCodex(root, [], {
      logPath,
      threads: [{ id: "thread-x", preview: "restored", cwd: root, createdAt: 1 }],
      loadedThreads: ["thread-x"],
      resumeConflict: true,
    });
    const manager = new CodexSessionManager({ bin, cwd: root, interpreter: process.execPath });
    try {
      await manager.start();
      expect(manager.listSessions().map((session) => session.id)).toContain("codex-thread-x");

      const session = await manager.prompt("codex-thread-x", "carry on");
      expect(session.id).toBe("codex-thread-x");

      // The idle turn releases our subscription so the engine can unload the
      // thread and drop the writer lock for other Sofia processes.
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline && !readCallLog(logPath).includes("thread/unsubscribe")) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(readCallLog(logPath)).toContain("thread/unsubscribe");
    } finally {
      await manager.close();
    }
  });

  test("getSessionItems follows item cursors so a long transcript is complete", async () => {
    const root = await createRoot();
    const logPath = join(root, "calls.log");
    const entry = (id: string, type: string) => ({ turnId: "turn-1", item: { id, type, text: id } });
    const bin = await writeFakeCodex(root, [], {
      logPath,
      itemsPages: [
        { data: [entry("u1", "userMessage"), entry("a1", "agentMessage")], nextCursor: "page-2" },
        { data: [entry("a2", "agentMessage")], nextCursor: "page-3" },
        { data: [entry("a3", "agentMessage")], nextCursor: null },
      ],
    });
    const manager = new CodexSessionManager({ bin, cwd: root, interpreter: process.execPath });
    try {
      const session = await manager.createSession({ title: "T", workspaceId: "ws_1", cwd: root });
      const items = await manager.getSessionItems(session.id);
      expect(items.map((item) => item.item.id)).toEqual(["u1", "a1", "a2", "a3"]);
      expect(readCallLog(logPath).filter((method) => method === "thread/items/list")).toHaveLength(3);
    } finally {
      await manager.close();
    }
  });

  test("getSessionItems keeps the newest items when a thread exceeds the cap", async () => {
    const root = await createRoot();
    const entry = (id: string) => ({ turnId: "turn-1", item: { id, type: "agentMessage", text: id } });
    const bin = await writeFakeCodex(root, [], {
      itemsPages: [
        { data: [entry("a1"), entry("a2")], nextCursor: "page-2" },
        { data: [entry("a3"), entry("a4")], nextCursor: null },
      ],
    });
    const manager = new CodexSessionManager({ bin, cwd: root, interpreter: process.execPath });
    try {
      const session = await manager.createSession({ title: "T", workspaceId: "ws_1", cwd: root });
      const items = await manager.getSessionItems(session.id, { limit: 3 });
      expect(items.map((item) => item.item.id)).toEqual(["a2", "a3", "a4"]);
    } finally {
      await manager.close();
    }
  });

  test("prompt explains a competing writer held by another Sofia process", async () => {
    const root = await createRoot();
    const bin = await writeFakeCodex(root, [], {
      threads: [{ id: "thread-y", preview: "restored", cwd: root, createdAt: 1 }],
      loadedThreads: [],
      resumeConflict: true,
    });
    const manager = new CodexSessionManager({ bin, cwd: root, interpreter: process.execPath });
    try {
      await expect(manager.prompt("codex-thread-y", "carry on")).rejects.toThrow(/open elsewhere/);
    } finally {
      await manager.close();
    }
  });

  test("threadBelongsToWorkspace groups subdirectories, excludes unrelated cwds", () => {
    // Exact workspace root matches.
    expect(threadBelongsToWorkspace("/repo", "/repo")).toBe(true);
    // Subdirectory session belongs to the workspace (TUI groups it the same way).
    expect(threadBelongsToWorkspace("/repo", "/repo/tween-auth")).toBe(true);
    // Workspace deeper than the session cwd also matches.
    expect(threadBelongsToWorkspace("/repo/apps/server", "/repo")).toBe(true);
    // Unrelated cwd is excluded.
    expect(threadBelongsToWorkspace("/repo", "/somewhere/else")).toBe(false);
    // Missing cwd is treated as a match (older stores omit it).
    expect(threadBelongsToWorkspace("/repo", undefined)).toBe(true);
    expect(threadBelongsToWorkspace("/repo", "")).toBe(true);
  });

  test("steer maps engine rejections to CodexSteerError codes", async () => {
    const root = await createRoot();
    const bin = await writeFakeCodex(root);
    const manager = new CodexSessionManager({ bin, cwd: root, interpreter: process.execPath });
    try {
      const session = await manager.createSession({ title: "T", workspaceId: "ws_1", cwd: root });
      // Keep a turn in flight so the steer reaches the engine.
      await manager.prompt(session.id, "hold");
      await expect(manager.steer(session.id, "steer-no-active now")).rejects.toMatchObject({
        code: "no_active_turn",
      });
      await expect(manager.steer(session.id, "steer-not-steerable now")).rejects.toMatchObject({
        code: "not_steerable",
      });
    } finally {
      await manager.close();
    }
  });

  test("prompt tracks per-turn cwd", async () => {
    const root = await createRoot();
    const bin = await writeFakeCodex(root);
    const manager = new CodexSessionManager({ bin, cwd: root, interpreter: process.execPath });
    try {
      const session = await manager.createSession({ title: "T", workspaceId: "ws_1" });
      expect(session.cwd).toBe(root);
      const sub = join(root, "sub");
      await manager.prompt(session.id, "work here", { cwd: sub });
      expect(manager.getSession(session.id)?.cwd).toBe(sub);
    } finally {
      await manager.close();
    }
  });

  test("prompt applies a changed provider and model before the turn", async () => {
    const root = await createRoot();
    const bin = await writeFakeCodex(root);
    const manager = new CodexSessionManager({ bin, cwd: root, interpreter: process.execPath });
    try {
      const session = await manager.createSession({
        title: "T",
        workspaceId: "ws_1",
        model: "model-a",
        providerId: "provider-a",
      });
      const updated = await manager.prompt(session.id, "switch", {
        model: "model-b",
        providerId: "provider-b",
      });
      expect(updated.model).toBe("model-b");
      expect(updated.providerId).toBe("provider-b");
    } finally {
      await manager.close();
    }
  });

  test("prompt that changes only the provider still sends the model", async () => {
    // Provider and model are one selection. Sending only `modelProvider` left
    // the engine's previously configured model in place, so the provider
    // flipped while a stale model id survived — DeepSeek being handed
    // OpenRouter's `stealth/space-bunny-alpha`.
    const root = await createRoot();
    const settingsLogPath = join(root, "settings.log");
    const manager = new CodexSessionManager({
      bin: await writeFakeCodex(root, [], { settingsLogPath }),
      cwd: root,
      interpreter: process.execPath,
    });
    try {
      const session = await manager.createSession({
        title: "T",
        workspaceId: "ws_1",
        model: "model-a",
        providerId: "provider-a",
      });
      await manager.prompt(session.id, "same model, new provider", {
        model: "model-a",
        providerId: "provider-b",
      });
      const lines = readFileSync(settingsLogPath, "utf8").trim().split("\n").filter(Boolean);
      const update = JSON.parse(lines[lines.length - 1]) as { model?: string; modelProvider?: string };
      expect(update.modelProvider).toBe("provider-b");
      expect(update.model).toBe("model-a");
    } finally {
      await manager.close();
    }
  });

  test("surfaces rateLimit.updated and notification approvals", async () => {
    const root = await createRoot();
    const notifications = [
      { method: "account/rateLimits/updated", params: { rateLimits: { limitId: "codex", rateLimitReachedType: "soft" } } },
      { method: "item/commandExecution/requestApproval", params: { command: "rm -rf /" } },
    ];
    const bin = await writeFakeCodex(root, notifications);
    const manager = new CodexSessionManager({ bin, cwd: root, interpreter: process.execPath });
    const seen: string[] = [];
    manager.on((event) => {
      if (event.type === "rateLimit.updated") seen.push(`rate:${(event as { rateLimits: { limitId: string } }).rateLimits.limitId}`);
      if (event.type === "approval.requested") seen.push(`approval:${(event as { params: { command: string } }).params.command}`);
    });
    try {
      const session = await manager.createSession({ title: "T", workspaceId: "ws_1" });
      // Prompt so the session is registered before the notifications stream on turn/start.
      await manager.prompt(session.id, "hi").catch(() => undefined);
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline && seen.length < 2) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(seen).toContain("rate:codex");
      expect(seen).toContain("approval:rm -rf /");
    } finally {
      await manager.close();
    }
  });

  test("the pending placeholder never becomes the engine's thread name", async () => {
    const root = await createRoot();
    const logPath = join(root, "calls.log");
    const bin = await writeFakeCodex(root, [], {
      logPath,
      readThreads: {
        "thread-1": { thread: { id: "thread-1", name: null, preview: "launch and navigate ruut.chat" } },
      },
    });
    const manager = new CodexSessionManager({ bin, cwd: root, interpreter: process.execPath });
    const updatedTitles: string[] = [];
    manager.on((event) => {
      if (event.type === "session.updated") updatedTitles.push(event.session.title);
    });
    try {
      const session = await manager.createSession({ title: "New Sofia task", workspaceId: "ws_1" });
      // Writing the placeholder as the thread name would shadow the title the
      // engine derives from the first user message for every client.
      expect(readCallLog(logPath)).not.toContain("thread/name/set");
      expect(session.title).toBe("");

      await manager.prompt(session.id, "launch and navigate ruut.chat");
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline && !manager.getSession(session.id)?.title) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(manager.getSession(session.id)?.title).toBe("launch and navigate ruut.chat");
      expect(updatedTitles).toContain("launch and navigate ruut.chat");
    } finally {
      await manager.close();
    }
  });

  test("a stored placeholder name does not mask the generated title", async () => {
    const root = await createRoot();
    const bin = await writeFakeCodex(root, [], {
      threads: [
        { id: "thread-pending", name: "New Sofia task", preview: "review the release driver", cwd: root },
        { id: "thread-renamed", name: "My rename", preview: "first message", cwd: root },
      ],
    });
    const manager = new CodexSessionManager({ bin, cwd: root, interpreter: process.execPath });
    try {
      await manager.start();
      expect(manager.listSessions().map((session) => [session.threadId, session.title])).toEqual([
        ["thread-pending", "review the release driver"],
        ["thread-renamed", "My rename"],
      ]);
    } finally {
      await manager.close();
    }
  });
});

describe("engine-derived task titles", () => {
  test("keeps a plain single-line title verbatim", () => {
    expect(threadTitleFromEngineText("launch and navigate ruut.chat")).toBe("launch and navigate ruut.chat");
    expect(threadTitleFromEngineText("review the release driver")).toBe("review the release driver");
    expect(threadTitleFromEngineText("  tidy   the   header  ")).toBe("tidy the header");
  });

  test("skips pasted code and comment banners instead of rendering them", () => {
    // The first user message often *is* code; the header must not show it raw.
    expect(threadTitleFromEngineText("```ts\nconst a = 1;\n```\nFix the browser pill")).toBe("Fix the browser pill");
    expect(threadTitleFromEngineText("// A throw must not reach the root")).toBe("A throw must not reach the root");
    expect(threadTitleFromEngineText("/* a comment banner */")).toBe("a comment banner");
    expect(threadTitleFromEngineText("> quoted line\n\n- the real request")).toBe("quoted line");
    expect(threadTitleFromEngineText("\n\n# Fix the header\nmore text")).toBe("Fix the header");
  });

  test("drops the markdown the engine left inside the title", () => {
    expect(
      threadTitleFromEngineText("I agree, but **presentation is the problem**"),
    ).toBe("I agree, but presentation is the problem");
    expect(threadTitleFromEngineText("fix the `browser pill` and ship")).toBe("fix the browser pill and ship");
    // Underscores belong to identifiers; they are not emphasis to strip.
    expect(threadTitleFromEngineText("set SOFIA_HOME before the run")).toBe("set SOFIA_HOME before the run");
  });

  test("repairs the halves an engine truncation leaves behind", () => {
    expect(threadTitleFromEngineText("…n these screenshots Sofia feels mor…")).toBe("these screenshots Sofia feels mor…");
  });

  test("cuts a long message on a word boundary, never mid-word", () => {
    // A pasted `//` banner ends the sentence the user actually wrote.
    expect(
      threadTitleFromEngineText(
        "let also get rid of this browser indicator widget// A throw inside the session surface must not reach the root without a boundary",
      ),
    ).toBe("let also get rid of this browser indicator widget");

    // With no banner to cut at it truncates on a word boundary, and says so.
    const long = threadTitleFromEngineText(
      "please rework the session header so the title it shows is the operation the agent is running rather than a slice of whatever the user pasted",
    );
    expect(long.endsWith("…")).toBe(true);
    expect(long.length).toBeLessThanOrEqual(THREAD_TITLE_MAX_LENGTH + 1);
    expect(long.includes(" ")).toBe(true);
    expect(long).not.toMatch(/\s…$/);
  });

  test("answers with nothing when there are no words to show", () => {
    expect(threadTitleFromEngineText("   \n```\n```\n   ")).toBe("");
    expect(threadTitleFromEngineText(undefined)).toBe("");
    expect(threadTitleFromEngineText("```\n…```")).toBe("");
  });
});

describe("resolveRevertBoundary", () => {
  const items = [
    { turnId: "t1", item: { id: "m1" } },
    { turnId: "t1", item: { id: "a1" } },
    { turnId: "t2", item: { id: "m2" } },
    { turnId: "t2", item: { id: "a2" } },
    { turnId: "t3", item: { id: "m3" } },
    { turnId: "t3", item: { id: "a3" } },
  ];

  test("anchors on the turn holding the clicked message", () => {
    // Reverting to m2 drops t2 and t3, keeping only t1.
    expect(resolveRevertBoundary(items, "m2")).toBe("t2");
  });

  test("reverting the first turn has no prefix to keep", () => {
    // Anchoring on t1 would wipe the whole transcript, so there is no boundary.
    expect(resolveRevertBoundary(items, "m1")).toBeNull();
  });

  test("reverting the newest turn keeps everything earlier", () => {
    expect(resolveRevertBoundary(items, "m3")).toBe("t3");
  });

  test("resolves an assistant message to its own turn", () => {
    expect(resolveRevertBoundary(items, "a2")).toBe("t2");
  });

  test("returns null for a message that is not in the transcript", () => {
    expect(resolveRevertBoundary(items, "missing")).toBeNull();
  });

  test("returns null for an empty transcript", () => {
    expect(resolveRevertBoundary([], "m1")).toBeNull();
  });
});
