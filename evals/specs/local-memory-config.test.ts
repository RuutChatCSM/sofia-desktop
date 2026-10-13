import { expect } from "vitest";
import { test } from "@sofia/testkit";
import { applyLocalMemoryToml } from "../../apps/server/src/codex-memory-config";
import { mergeWorkspaceEngineConfigs } from "../../apps/server/src/runtime-engine-config-store";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerConfig } from "../../apps/server/src/types";

test("local memory stays off until opted in and preserves native configuration without an app preference", () => {
  const native = "[features]\nmemories = true\n";
  expect(applyLocalMemoryToml(native, undefined, null)).toBe(native);
  const disabled = applyLocalMemoryToml(native, { use_memories: false, generate_memories: false }, null);
  expect(disabled).toContain("memories = false");
  expect(disabled).toContain("use_memories = false");
  expect(disabled).toContain("generate_memories = false");
});

test("local recall and generation are independent and custom provider jobs use its configured model", () => {
  const config = applyLocalMemoryToml("[features]\nmulti_agent_v2 = true\n", { use_memories: true, generate_memories: false }, "custom-model");
  expect(config.match(/\[features\]/g)).toHaveLength(1);
  expect(config).toContain("multi_agent_v2 = true");
  expect(config).toContain("memories = true");
  expect(config).toContain("generate_memories = false");
  expect(config).toContain('extract_model = "custom-model"');
  expect(config).toContain('consolidation_model = "custom-model"');
  expect(config).not.toContain("gpt-");
});

test("generation cannot silently use an unsupported default model", () => {
  expect(() => applyLocalMemoryToml("", { use_memories: false, generate_memories: true }, null)).toThrow("Choose a provider model");
});

test("effective configuration preserves workspace local memory settings", () => {
  const memories = { use_memories: true, generate_memories: false };
  expect(mergeWorkspaceEngineConfigs({}, { memories }).memories).toEqual(memories);
});

test("workspace config API persists local memory and existing discovery sections", async () => {
  const root = await mkdtemp(join(tmpdir(), "sofia-memory-settings-"));
  const previousDb = process.env.SOFIA_RUNTIME_DB;
  process.env.SOFIA_RUNTIME_DB = join(root, "runtime.sqlite");
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "memory-test-token", hostToken: "memory-host-token",
    configPath: join(root, "server.json"), approval: { mode: "auto", timeoutMs: 0 },
    corsOrigins: [], workspaces: [{ id: "memory-test", name: "Memory test", path: root, preset: "starter", workspaceType: "local" }],
    authorizedRoots: [root], readOnly: false, startedAt: Date.now(), tokenSource: "generated",
    hostTokenSource: "generated", logFormat: "pretty", logRequests: false,
  };
  const { startServer } = await import("../../apps/server/src/server");
  const server = await startServer(config);
  try {
    const url = `http://127.0.0.1:${server.port}/workspace/memory-test/config`;
    const headers = { authorization: "Bearer memory-test-token", "content-type": "application/json" };
    const memories = { use_memories: true, generate_memories: false };
    const skills = { discoverCodexSkills: false, additionalDirectories: ["/test/skills"] };
    expect((await fetch(url, { method: "PATCH", headers, body: JSON.stringify({ engine: { memories, skills, compaction: { auto: false } } }) })).status).toBe(200);
    const response = await fetch(url, { headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ engine: { memories, skills, compaction: { auto: false } } });
    const { readRuntimeWorkspaceEngineConfig } = await import("../../apps/server/src/runtime-engine-config-store");
    expect(await readRuntimeWorkspaceEngineConfig(config, "memory-test")).toMatchObject({ memories, skills, compaction: { auto: false } });
  } finally {
    await server.stop();
    if (previousDb === undefined) delete process.env.SOFIA_RUNTIME_DB;
    else process.env.SOFIA_RUNTIME_DB = previousDb;
    await rm(root, { recursive: true, force: true });
  }
});
