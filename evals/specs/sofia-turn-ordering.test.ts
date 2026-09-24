import { expect } from "vitest";
import { test } from "@sofia/testkit";
import { resolve } from "node:path";
import { CodexSessionManager } from "../../apps/server/src/codex-sessions.ts";

async function withManager(env: Record<string, string>, run: (manager: CodexSessionManager, id: string) => Promise<void>) {
  const manager = new CodexSessionManager({ bin: resolve(import.meta.dirname, "../fixtures/sofia-engine.mjs"), interpreter: process.execPath, cwd: process.cwd(), env }, "ws");
  try {
    const session = await manager.createSession({ workspaceId: "ws", title: "Ordering" });
    await run(manager, session.id);
  } finally { await manager.close(); }
}

test("a completed turn stays idle when the start response arrives late", async () => {
  await withManager({ SOFIA_FIXTURE_COMPLETE_BEFORE_START_REPLY: "1" }, async (manager, id) => {
    const result = await manager.prompt(id, "Hello");
    expect(result.status).toBe("idle");
    expect(result.turnId).toBeNull();
  });
});

test("a late steer acknowledgement cannot resurrect a completed turn", async () => {
  await withManager({}, async (manager, id) => {
    await manager.prompt(id, "Hello");
    const result = await manager.steer(id, "Focus on the tests");
    expect(result.status).toBe("idle");
    expect(result.turnId).toBeNull();
  });
});

test("completion from an older turn cannot stop the current turn", async () => {
  await withManager({ SOFIA_FIXTURE_STALE_COMPLETION: "1" }, async (manager, id) => {
    await manager.prompt(id, "Hello");
    const result = await manager.steer(id, "Focus on the tests");
    expect(result.status).toBe("running");
    expect(result.turnId).toBe("turn-active");
  });
});

test("a rejected steer preserves the running turn for retry or queueing", async () => {
  await withManager({ SOFIA_FIXTURE_REJECT_STEER: "1" }, async (manager, id) => {
    await manager.prompt(id, "Hello");
    await expect(manager.steer(id, "Focus on the tests")).rejects.toMatchObject({ code: "not_steerable" });
    expect(manager.getSession(id)?.status).toBe("running");
    expect(manager.getSession(id)?.turnId).toBe("turn-active");
  });
});
