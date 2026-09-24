import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildSofiaRuntimeConfigObject } from "./sofia-runtime-config.js";
import { writeRuntimeWorkspaceEngineConfig } from "./runtime-engine-config-store.js";
import type { ServerConfig } from "./types.js";

const roots: string[] = [];
let previousDb: string | undefined;

afterEach(async () => {
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
  if (previousDb === undefined) delete process.env.SOFIA_RUNTIME_DB;
  else process.env.SOFIA_RUNTIME_DB = previousDb;
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "sofia-runtime-config-"));
  roots.push(root);
  previousDb = process.env.SOFIA_RUNTIME_DB;
  process.env.SOFIA_RUNTIME_DB = join(root, "runtime.sqlite");
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    token: "owt_test_token",
    hostToken: "owt_host_token",
    approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: ["*"],
    workspaces: [
      { id: "ws_1", name: "Workspace", path: root, preset: "starter", workspaceType: "local" },
    ],
    authorizedRoots: [root],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
  return { root, config };
}

describe("sofia runtime config", () => {
  test("builds runtime-DB MCPs and sofia defaults", async () => {
    const { config } = await setup();
    await writeRuntimeWorkspaceEngineConfig(config, "ws_1", (current) => ({
      ...current,
      mcp: {
        posthog: { type: "remote", url: "https://mcp.posthog.com/mcp", enabled: true },
        "sofia-connect-stale": { type: "remote", url: "https://cloud.example/stale", enabled: true },
      },
    }));

    const parsed = await buildSofiaRuntimeConfigObject(config, "ws_1");
    const mcp = parsed.mcp as Record<string, Record<string, unknown>>;
    expect(mcp.posthog?.enabled).toBe(true);
    expect(mcp["sofia-connect-stale"]).toBeUndefined();
    expect(parsed.default_agent).toBe("sofia");
    expect(Array.isArray(parsed.plugin)).toBe(true);
    expect(parsed.agent).toMatchObject({
      sofia: {
        permission: {
          skill: {
            "customize-engine": "deny",
            "get-started": "deny",
            "command-creator": "deny",
            "agent-creator": "deny",
            "plugin-creator": "deny",
          },
        },
      },
    });
  });

  test("registers the chrome-devtools MCP against the CDP broker when exposed", async () => {
    const { config } = await setup();
    const previous = process.env.SOFIA_ELECTRON_AGENT_CDP_BASE_URL;
    process.env.SOFIA_ELECTRON_AGENT_CDP_BASE_URL = "http://127.0.0.1:9401";
    try {
      const parsed = await buildSofiaRuntimeConfigObject(config, "ws_1");
      const mcp = (parsed.mcp ?? {}) as Record<string, Record<string, unknown>>;
      const browser = mcp["chrome-devtools"];
      expect(browser).toBeDefined();
      expect(browser?.type).toBe("local");
      expect(browser?.enabled).toBe(true);
      const command = browser?.command as string[];
      expect(command.join(" ")).toContain("chrome-devtools-mcp@latest");
      expect(command.join(" ")).toContain("--browser-url=http://127.0.0.1:9401");
      expect(parsed.plugin).not.toContain("engine-chrome-devtools");
    } finally {
      if (previous === undefined) delete process.env.SOFIA_ELECTRON_AGENT_CDP_BASE_URL;
      else process.env.SOFIA_ELECTRON_AGENT_CDP_BASE_URL = previous;
    }
  });

  test("omits the chrome-devtools MCP when no CDP broker is exposed", async () => {
    const { config } = await setup();
    const previous = process.env.SOFIA_ELECTRON_AGENT_CDP_BASE_URL;
    delete process.env.SOFIA_ELECTRON_AGENT_CDP_BASE_URL;
    try {
      const parsed = await buildSofiaRuntimeConfigObject(config, "ws_1");
      const mcp = (parsed.mcp ?? {}) as Record<string, Record<string, unknown>>;
      expect(mcp["chrome-devtools"]).toBeUndefined();
    } finally {
      if (previous !== undefined) process.env.SOFIA_ELECTRON_AGENT_CDP_BASE_URL = previous;
    }
  });

  test("sofia prompt has a static search-first Memory Bank section, distinct from ## Memory", async () => {
    const { config } = await setup();

    const parsed = await buildSofiaRuntimeConfigObject(config, "ws_1");
    const agent = parsed.agent as Record<string, { prompt?: string }>;
    const prompt = agent.sofia?.prompt ?? "";

    // The new Memory Bank section is present and distinct from the existing ## Memory section.
    expect(prompt).toContain("## Memory Bank");
    expect(prompt).toContain("## Memory\n");
    // Search-first (B1): never name tools that do not exist.
    expect(prompt).toContain("search_capabilities");
    expect(prompt).toContain("execute_capability");
    expect(prompt).not.toContain("memory_save");
    expect(prompt).not.toContain("memory_search");
    // No-secrets guidance is the only v0 plaintext-at-rest mitigation.
    expect(prompt).toMatch(/secret|credential|API key|token|PII/i);
  });

  test("builds stable config for repeated snapshots", async () => {
    const { config } = await setup();
    await writeRuntimeWorkspaceEngineConfig(config, "ws_1", (current) => ({
      ...current,
      mcp: { posthog: { type: "remote", url: "https://mcp.posthog.com/mcp" } },
    }));

    const first = await buildSofiaRuntimeConfigObject(config, "ws_1");
    const second = await buildSofiaRuntimeConfigObject(config, "ws_1");

    expect(second).toEqual(first);
  });

  test("builds stable config for equivalent snapshots with different key order", async () => {
    const { config } = await setup();
    await writeRuntimeWorkspaceEngineConfig(config, "ws_1", () => ({
      mcp: {
        zeta: { url: "https://z.example/mcp", type: "remote" },
        alpha: { type: "remote", url: "https://a.example/mcp" },
      },
      provider: {
        zeta: { npm: "@ai-sdk/openai-compatible", name: "Zeta" },
        alpha: { name: "Alpha", npm: "@ai-sdk/openai-compatible" },
      },
    }));
    const first = await buildSofiaRuntimeConfigObject(config, "ws_1");

    await writeRuntimeWorkspaceEngineConfig(config, "ws_1", () => ({
      provider: {
        alpha: { npm: "@ai-sdk/openai-compatible", name: "Alpha" },
        zeta: { name: "Zeta", npm: "@ai-sdk/openai-compatible" },
      },
      mcp: {
        alpha: { url: "https://a.example/mcp", type: "remote" },
        zeta: { type: "remote", url: "https://z.example/mcp" },
      },
    }));
    const second = await buildSofiaRuntimeConfigObject(config, "ws_1");

    expect(second).toEqual(first);
  });
});
