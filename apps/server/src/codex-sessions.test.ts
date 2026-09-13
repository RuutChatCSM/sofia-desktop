import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { CodexSessionManager, codexSessionId, isCodexSessionId } from "./codex-sessions.js";

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
});

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "openwork-codex-sessions-"));
  roots.push(root);
  return root;
}

async function writeFakeCodex(root: string, notifications: Array<{ method: string; params: Record<string, unknown> }> = []): Promise<string> {
  const path = join(root, "codex.js");
  await writeFile(path, [
    "import { createInterface } from 'node:readline';",
    "if (process.argv.includes('--version')) {",
    "  process.stdout.write('codex-cli 0.149.1\\n');",
    "  process.exit(0);",
    "}",
    "const rl = createInterface({ input: process.stdin });",
    "const notifications = " + JSON.stringify(notifications) + ";",
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
    "  if (msg.method === 'initialize') {",
    "    send({ jsonrpc: '2.0', id: msg.id, result: { userAgent: 'fake-codex', codexHome: '/tmp/fake-codex-home' } });",
    "  } else if (msg.method === 'thread/start') {",
    "    const threadId = 'thread-' + (++id);",
    "    send({ jsonrpc: '2.0', id: msg.id, result: { threadId } });",
    "    emitNotifications(threadId, null);",
    "  } else if (msg.method === 'turn/start') {",
    "    const turnId = 'turn-' + (++id);",
    "    const threadId = msg.params.threadId;",
    "    send({ jsonrpc: '2.0', id: msg.id, result: { threadId, turnId } });",
    "    // Stream a fake agent message delta, then complete the turn.",
    "    setTimeout(() => {",
    "      send({ jsonrpc: '2.0', method: 'item/started', params: { threadId, itemType: 'agentMessage' } });",
    "      send({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { threadId, delta: 'hello from codex' } });",
    "      send({ jsonrpc: '2.0', method: 'item/completed', params: { threadId, itemType: 'agentMessage' } });",
    "      emitNotifications(threadId, turnId);",
    "      send({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId, turnId } });",
    "    }, 30);",
    "  } else if (msg.method === 'thread/fork') {",
    "    send({ jsonrpc: '2.0', id: msg.id, result: { threadId: 'forked-' + (++id) } });",
    "  } else if (msg.method === 'turn/steer') {",
    "    send({ jsonrpc: '2.0', id: msg.id, result: { turnId: 'steered-' + (++id) } });",
    "  } else if (msg.method === 'thread/resume' || msg.method === 'thread/archive' || msg.method === 'thread/unarchive' || msg.method === 'thread/unsubscribe' || msg.method === 'turn/interrupt') {",
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
    expect(isCodexSessionId("opencode-session-1")).toBe(false);
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

  test("RPC parity: steer, fork, archive, unsubscribe at the session level", async () => {
    const root = await createRoot();
    const bin = await writeFakeCodex(root);
    const manager = new CodexSessionManager({ bin, cwd: root, interpreter: process.execPath });
    try {
      const session = await manager.createSession({ title: "T", workspaceId: "ws_1", cwd: root });
      expect(session.cwd).toBe(root);

      const steered = await manager.steer(session.id, "go on");
      expect(steered.turnId).toMatch(/^steered-/);
      expect(manager.getSession(session.id)?.status).toBe("running");

      const forked = await manager.forkSession(session.id, "copy this");
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
});
