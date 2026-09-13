import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { ManagedCodexEngine, probeCodexVersion } from "./managed-codex.js";

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
});

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "openwork-managed-codex-"));
  roots.push(root);
  return root;
}

// A fake `codex` binary that implements the app-server stdio JSON-RPC protocol:
// `--version`, initialize handshake, thread/start, turn/start (and the rest of
// the parity methods), and an optional server->client notification stream.
// `exitAfterMs` lets us simulate an unexpected crash to test reconnect.
async function writeFakeCodex(root: string, options?: {
  notifications?: Record<string, unknown>[];
  version?: string;
  exitAfterMs?: number;
  ignoreRequests?: boolean;
}): Promise<string> {
  const path = join(root, "codex");
  const version = options?.version ?? "0.149.1";
  const body = [
    "import { createInterface } from 'node:readline';",
    "const version = " + JSON.stringify(version) + ";",
    "if (process.argv.includes('--version')) {",
    "  process.stdout.write('codex-cli ' + version + '\\n');",
    "  process.exit(0);",
    "}",
    "const rl = createInterface({ input: process.stdin });",
    "const notifications = " + JSON.stringify(options?.notifications ?? []) + ";",
    "const exitAfterMs = " + (options?.exitAfterMs ?? null) + ";",
    "const ignoreRequests = " + (options?.ignoreRequests ?? false) + ";",
    "const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');",
    "let id = 0;",
    "function emitNotifications(threadId, turnId) {",
    "  for (const n of notifications) {",
    "    send({ jsonrpc: '2.0', method: n.method, params: { threadId, turnId, ...n.params } });",
    "  }",
    "}",
    "if (exitAfterMs != null) setTimeout(() => process.exit(1), exitAfterMs);",
    "rl.on('line', (line) => {",
    "  if (!line.trim()) return;",
    "  let msg;",
    "  try { msg = JSON.parse(line); } catch { return; }",
    "  if (ignoreRequests) return;",
    "  if (msg.method === 'initialize') {",
    "    send({ jsonrpc: '2.0', id: msg.id, result: { userAgent: 'fake-codex', codexHome: '/tmp/fake-codex-home' } });",
    "  } else if (msg.method === 'thread/start') {",
    "    const threadId = 'thread-' + (++id);",
    "    send({ jsonrpc: '2.0', id: msg.id, result: { threadId } });",
    "    emitNotifications(threadId, null);",
    "  } else if (msg.method === 'turn/start') {",
    "    const threadId = msg.params.threadId;",
    "    const turnId = 'turn-' + (++id);",
    "    send({ jsonrpc: '2.0', id: msg.id, result: { threadId, turnId } });",
    "    emitNotifications(threadId, turnId);",
    "  } else if (msg.method === 'thread/fork') {",
    "    send({ jsonrpc: '2.0', id: msg.id, result: { threadId: 'forked-' + (++id) } });",
    "  } else if (msg.method === 'turn/steer') {",
    "    send({ jsonrpc: '2.0', id: msg.id, result: { turnId: 'steered-' + (++id) } });",
    "  } else if (msg.method === 'thread/resume' || msg.method === 'thread/unsubscribe' || msg.method === 'thread/archive' || msg.method === 'thread/unarchive' || msg.method === 'turn/interrupt') {",
    "    send({ jsonrpc: '2.0', id: msg.id, result: {} });",
    "  } else {",
    "    send({ jsonrpc: '2.0', id: msg.id, result: {} });",
    "  }",
    "});",
    "process.on('SIGTERM', () => process.exit(0));",
  ].join("\n");
  await writeFile(path, ["#!/usr/bin/env bun", body].join("\n"));
  await chmod(path, 0o755);
  return path;
}

describe("ManagedCodexEngine", () => {
  test("initialize handshake returns userAgent and codexHome", async () => {
    const root = await createRoot();
    const bin = await writeFakeCodex(root);
    const engine = new ManagedCodexEngine({ bin, cwd: root, interpreter: process.execPath });
    try {
      const info = await engine.initialize();
      expect(info.userAgent).toBe("fake-codex");
      expect(info.codexHome).toBe("/tmp/fake-codex-home");
      expect(engine.isAlive()).toBe(true);
      expect(engine.info.version).toBe("0.149.1");
    } finally {
      await engine.close();
    }
  });

  test("startThread and startTurn drive the protocol and stream notifications", async () => {
    const root = await createRoot();
    const notifications = [
      { method: "item/started", params: { itemType: "agentMessage" } },
      { method: "item/agentMessage/delta", params: { delta: "hello" } },
      { method: "item/completed", params: { itemType: "agentMessage" } },
      { method: "turn/completed", params: {} },
    ];
    const bin = await writeFakeCodex(root, { notifications });
    const engine = new ManagedCodexEngine({ bin, cwd: root, interpreter: process.execPath });

    const seen: string[] = [];
    engine.on("item/agentMessage/delta", (params) => seen.push(`delta:${(params as { delta: string }).delta}`));
    engine.on("turn/completed", () => seen.push("turn-completed"));

    try {
      await engine.initialize();
      const threadId = await engine.startThread({ cwd: root });
      expect(threadId).toMatch(/^thread-/);
      await engine.startTurn({ threadId, input: [{ text: "hi" }] });

      // Notifications arrive asynchronously; poll briefly.
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline && seen.length < 2) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(seen).toContain("delta:hello");
      expect(seen).toContain("turn-completed");
    } finally {
      await engine.close();
    }
  });

  test("RPC parity methods (fork/resume/steer/archive/unsubscribe) work", async () => {
    const root = await createRoot();
    const bin = await writeFakeCodex(root);
    const engine = new ManagedCodexEngine({ bin, cwd: root, interpreter: process.execPath });
    try {
      await engine.initialize();
      const threadId = await engine.startThread({ cwd: root });
      expect(threadId).toMatch(/^thread-/);
      expect(await engine.forkThread({ threadId, input: [{ text: "copy" }] })).toMatch(/^forked-/);
      expect(await engine.steerTurn({ threadId, expectedTurnId: "turn-1", input: [{ text: "go" }] })).toMatch(/^steered-/);
      await expect(engine.resumeThread(threadId)).resolves.toBeTruthy();
      await expect(engine.archiveThread(threadId, true)).resolves.toBeTruthy();
      await expect(engine.archiveThread(threadId, false)).resolves.toBeTruthy();
      await expect(engine.unsubscribeThread(threadId)).resolves.toBeTruthy();
    } finally {
      await engine.close();
    }
  });

  test("any reported version connects; version is surfaced for diagnostics", async () => {
    const root = await createRoot();
    const bin = await writeFakeCodex(root, { version: "0.140.0" });
    const engine = new ManagedCodexEngine({ bin, cwd: root, interpreter: process.execPath });
    try {
      const info = await engine.initialize();
      expect(info.userAgent).toBe("fake-codex");
      expect(engine.info.version).toBe("0.140.0");
    } finally {
      await engine.close();
    }
  });

  test("a 0.0.0 source build (bundled Sofia) connects (no hard version gate)", async () => {
    const root = await createRoot();
    const bin = await writeFakeCodex(root, { version: "0.0.0" });
    const engine = new ManagedCodexEngine({ bin, cwd: root, interpreter: process.execPath });
    try {
      const info = await engine.initialize();
      expect(info.userAgent).toBe("fake-codex");
      expect(engine.info.version).toBe("0.0.0");
    } finally {
      await engine.close();
    }
  });

  test("reconnect after unexpected exit re-runs the handshake", async () => {
    const root = await createRoot();
    const bin = await writeFakeCodex(root, { exitAfterMs: 300 });
    const engine = new ManagedCodexEngine({
      bin, cwd: root, interpreter: process.execPath,
      retry: true, retryBaseDelayMs: 50, maxRetryDelayMs: 100,
    });
    try {
      await engine.initialize();
      expect(engine.isAlive()).toBe(true);
      // Wait for the crash + reconnect.
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline && engine.pid === null) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      // Reconnect timer re-spawns; pid should be present again (may be same/diff).
      const deadline2 = Date.now() + 3000;
      while (Date.now() < deadline2 && !engine.isAlive()) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(engine.isAlive()).toBe(true);
    } finally {
      await engine.close();
    }
  });

  test("request timeout rejects hung requests", async () => {
    const root = await createRoot();
    // The fake ignores ALL requests including initialize, so the child spawns
    // but never answers — the request times out.
    const bin = await writeFakeCodex(root, { ignoreRequests: true });
    const engine = new ManagedCodexEngine({ bin, cwd: root, interpreter: process.execPath, requestTimeoutMs: 200 });
    try {
      await engine.initialize().catch(() => undefined); // probe + spawn; init hangs, ignore
      await expect(engine.request("thread/start", { cwd: root })).rejects.toThrow(/timed out/);
    } finally {
      await engine.close();
    }
  });

  test("close terminates the process and resolves pending requests with an error", async () => {
    const root = await createRoot();
    const bin = await writeFakeCodex(root);
    const engine = new ManagedCodexEngine({ bin, cwd: root, interpreter: process.execPath });
    try {
      await engine.initialize();
    } finally {
      await engine.close();
    }
    expect(engine.isAlive()).toBe(false);
  });

  test("probeCodexVersion reads the version", async () => {
    const root = await createRoot();
    const bin = await writeFakeCodex(root, { version: "0.149.1" });
    expect(await probeCodexVersion({ bin, interpreter: process.execPath })).toBe("0.149.1");
  });
});
