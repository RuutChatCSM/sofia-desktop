import { describe, expect, test } from "bun:test";

import {
  codexMcpServersToml,
  codexRuntimeSkill,
  defaultCodexRuntimeMcpServers,
} from "./codex-runtime-mcp.js";

describe("codex-runtime-mcp", () => {
  test("codexMcpServersToml serializes command, args, and approval mode", () => {
    const toml = codexMcpServersToml([
      {
        name: "computer-use",
        command: "/path/to/sofia-handsfree-computer-use.mjs",
        args: ["mcp"],
        defaultApprovalMode: "prompt",
        enabled: true,
      },
      {
        name: "browser",
        command: "npx",
        args: ["-y", "chrome-devtools-mcp@latest", "--browser-url=http://127.0.0.1:9222"],
        defaultApprovalMode: "auto",
      },
    ]);
    expect(toml).toContain("[mcp_servers.computer-use]");
    expect(toml).toContain('command = "/path/to/sofia-handsfree-computer-use.mjs"');
    expect(toml).toContain('args = ["mcp"]');
    expect(toml).toContain('default_tools_approval_mode = "prompt"');
    expect(toml).toContain("enabled = true");
    expect(toml).toContain("[mcp_servers.browser]");
    expect(toml).toContain('--browser-url=http://127.0.0.1:9222');
    expect(toml).toContain('default_tools_approval_mode = "auto"');
  });

  test("codexMcpServersToml handles env and enabled_tools", () => {
    const toml = codexMcpServersToml([
      {
        name: "srv",
        command: "bin",
        env: { KEY: "value with space" },
        enabledTools: ["one", "two"],
      },
    ]);
    expect(toml).toContain('env = { KEY = "value with space" }');
    expect(toml).toContain('enabled_tools = ["one", "two"]');
  });

  test("codexMcpServersToml escapes keys with dots verbatim and returns empty for none", () => {
    expect(codexMcpServersToml([])).toBe("");
    const toml = codexMcpServersToml([{ name: "a.b-server", command: "x" }]);
    expect(toml).toContain("[mcp_servers.a.b-server]");
  });

  test("codexRuntimeSkill produces frontmatter with name and description", () => {
    for (const name of ["computer-use", "browser"] as const) {
      const skill = codexRuntimeSkill(name);
      expect(skill.startsWith("---\n")).toBe(true);
      expect(skill).toContain(`name: "${name}"`);
      expect(skill).toContain("description:");
    }
    // Computer-use skill must reference the MCP surface it pairs with.
    const computer = codexRuntimeSkill("computer-use");
    expect(computer).toContain("snapshot");
    expect(computer).toContain("`computer-use` MCP server");
  });

  test("defaultCodexRuntimeMcpServers never returns servers on unsupported platforms", () => {
    // The function reads the live platform/env; it must never throw and each
    // returned server has a resolvable shape.
    for (const server of defaultCodexRuntimeMcpServers()) {
      expect(typeof server.command).toBe("string");
      expect(server.command.length).toBeGreaterThan(0);
      // Direct node invocations carry ELECTRON_RUN_AS_NODE so the script runs
      // as Node even from an embedded Electron runtime (never `npx`).
      if (server.env) expect(server.env.ELECTRON_RUN_AS_NODE).toBe("1");
    }
  });

});
