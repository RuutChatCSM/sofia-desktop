import { expect } from "vitest";
import { test } from "@sofia/testkit";
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import {
  defaultCodexRuntimeMcpServers,
  codexRuntimeSkill,
  codexDirectToolNamespacesToml,
  resolveBrowserReplInvocation,
} from "../../apps/server/src/codex-runtime-mcp.js";
import { listAssignedConnectCapabilities } from "../../apps/app/src/react-app/domains/session/surface/connect-capability-inventory.js";

test("browser MCP remains discoverable before its live broker publishes a URL", async ({ evidence }) => {
  const previousHome = process.env.SOFIA_HOME;
  const previousUrl = process.env.SOFIA_ELECTRON_AGENT_CDP_BASE_URL;
  try {
    process.env.SOFIA_HOME = "/a/sofia/home/that/does/not/exist";
    delete process.env.SOFIA_ELECTRON_AGENT_CDP_BASE_URL;
    const invocation = resolveBrowserReplInvocation();
    expect(invocation?.args[0]).toMatch(/sofia-browser-repl\.mjs$/);
    expect(invocation?.env.SOFIA_BROWSER_CDP_URL).toBeUndefined();
    expect(defaultCodexRuntimeMcpServers().some((server) => server.name === "node_repl" && server.enabled)).toBe(true);
    evidence.recordAssertionEvidence(
      "The browser tool is registered before the browser bridge starts",
      "With no broker URL or discovery file, the harness still registers as node_repl and can discover the broker at call time.",
      true,
    );
  } finally {
    if (previousHome === undefined) delete process.env.SOFIA_HOME;
    else process.env.SOFIA_HOME = previousHome;
    if (previousUrl === undefined) delete process.env.SOFIA_ELECTRON_AGENT_CDP_BASE_URL;
    else process.env.SOFIA_ELECTRON_AGENT_CDP_BASE_URL = previousUrl;
  }
});

test("one failed Connect plugin does not erase a healthy skill", async ({ evidence }) => {
  const marketplace = {
    id: "team", name: "Team tools", description: null, status: "active" as const,
    pluginCount: 2, updatedAt: null,
  };
  const plugins = ["healthy", "broken"].map((id) => ({
    id, name: id, description: null, status: "active" as const,
    memberCount: 1, updatedAt: null, componentCounts: { skill: 1 },
  }));
  const inventory = await listAssignedConnectCapabilities({
    organizationId: "org",
    client: {
      listAssignedMarketplaceCapabilities: async () => plugins.map((plugin) => ({
        marketplaceId: "team", pluginId: plugin.id, configObjectId: `${plugin.id}-skill`, objectType: "skill",
      })),
      listOrgMarketplaces: async () => [marketplace],
      getOrgMarketplaceResolved: async () => ({ marketplace, plugins }),
      getOrgPluginResolved: async (_org, plugin) => {
        if (plugin.id === "broken") throw new Error("temporary Den failure");
        return { plugin, memberships: [{
          id: "membership", pluginId: plugin.id, configObjectId: "healthy-skill",
          configObject: {
            id: "healthy-skill", objectType: "skill", title: "Healthy skill", description: null,
            currentFileName: "SKILL.md", currentFileExtension: "md",
            currentRelativePath: "skills/healthy/SKILL.md", status: "active" as const,
            updatedAt: null, latestVersion: null,
          },
        }] };
      },
    },
  });
  expect(inventory.skills.map((skill) => skill.name)).toEqual(["Healthy skill"]);
  expect(inventory.plugins.map((plugin) => plugin.pluginId)).toEqual(["healthy"]);
  evidence.recordAssertionEvidence(
    "A failing Connect plugin cannot blank other capabilities",
    "One plugin resolution rejects while a sibling skill remains in the returned member inventory.",
    true,
  );
});

test("the built browser MCP starts with its bundled cursor dependency", async ({ evidence }) => {
  const serverRoot = resolve(import.meta.dirname, "../../apps/server");
  execFileSync(process.execPath, [resolve(serverRoot, "scripts/copy-runtime-assets.mjs")]);
  expect(existsSync(resolve(serverRoot, "dist/browser-cursor.mjs"))).toBe(true);

  const harness = spawn(process.execPath, [resolve(serverRoot, "dist/sofia-browser-repl.mjs")], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  try {
    const response = await new Promise<string>((resolveResponse, reject) => {
      let output = "";
      const timeout = setTimeout(() => reject(new Error("browser MCP did not initialize")), 4000);
      harness.once("error", reject);
      harness.once("exit", (code) => reject(new Error(`browser MCP exited before initialization: ${code}`)));
      harness.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes('"id":1,"result"')) {
          clearTimeout(timeout);
          resolveResponse(output);
        }
      });
      harness.stdin.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n');
    });
    expect(response).toContain('"name":"sofia-browser-repl"');
    evidence.recordAssertionEvidence(
      "The packaged browser MCP initializes with its cursor module present",
      "The copied dist harness answered MCP initialize in a child process, and its relative browser-cursor import resolved.",
      true,
    );
  } finally {
    harness.kill();
  }
});


test("browser availability separates discovery from live connection failure", async ({ evidence }) => {
  const servers = defaultCodexRuntimeMcpServers();
  const browser = servers.find((server) => server.name === 'node_repl');
  expect(browser?.enabledTools).toEqual(['js']);
  expect(browser?.startupTimeoutSec).toBe(20);
  expect(codexDirectToolNamespacesToml(browser ? [browser] : [])).toContain('mcp__node_repl');
  const skill = codexRuntimeSkill('browser');
  expect(skill).toContain('use the runtime tool discovery/search facility');
  expect(skill).toContain('A previous unavailable turn is not evidence about this turn');
  expect(skill).not.toContain('If it is missing from your tool list the in-app browser bridge failed to start');
  evidence.recordAssertionEvidence('Browser availability has distinct states', 'Browser registration allows the js tool with an explicit startup timeout and direct namespace. Its skill requires discovery before reporting turn-level tool unavailability and actual tool errors before claiming a connection failure.', true);
});
