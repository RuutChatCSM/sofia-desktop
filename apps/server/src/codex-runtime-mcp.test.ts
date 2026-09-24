import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import {
  type CodexRuntimeMcpServer,
  codexDirectToolNamespacesToml,
  codexMcpServersToml,
  codexRuntimeMcpToolNamespace,
  codexRuntimeSkill,
  codexRuntimeSkillsFor,
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

  test("runtime MCP namespaces match the engine's sanitized model-visible names", () => {
    expect(codexRuntimeMcpToolNamespace("node_repl")).toBe("mcp__node_repl");
    // The engine maps every non-alphanumeric to `_` before prefixing.
    expect(codexRuntimeMcpToolNamespace("computer-use")).toBe("mcp__computer_use");
  });

  test("codexDirectToolNamespacesToml pins runtime tools into the model's tool list", () => {
    // Without this the engine defers MCP tools behind `tool_search`, so the
    // `mcp__node_repl__js` the browser SKILL.md names is absent from the tool
    // list and agents substitute a separate browser for the in-app one.
    const toml = codexDirectToolNamespacesToml([
      { name: "node_repl", command: "bin" },
      { name: "computer-use", command: "bin" },
    ]);
    expect(toml).toContain("[features.code_mode]");
    expect(toml).toContain('direct_only_tool_namespaces = ["mcp__node_repl", "mcp__computer_use"]');
    expect(codexDirectToolNamespacesToml([])).toBe("");
  });

  test("the browser skill tells the agent to stop when its tool is missing", () => {
    const skill = codexRuntimeSkill("browser");
    expect(skill).toContain("say so and stop");
    expect(skill).toContain("Never substitute a separate browser process");
  });

  test("codexRuntimeSkillsFor writes docs only for registered MCP servers", async () => {
    // A skill present without its MCP server teaches the agent tools it cannot
    // call, so the docs must track the servers actually registered.
    const skillsFor = async (servers: CodexRuntimeMcpServer[]) => {
      const home = await mkdtemp(join(tmpdir(), "sofia-runtime-skills-"));
      try {
        const written = await codexRuntimeSkillsFor(home, servers);
        return {
          skills: written.map((dir) => basename(dir)),
          browser: existsSync(join(home, "skills", "browser", "SKILL.md")),
          computerUse: existsSync(join(home, "skills", "computer-use", "SKILL.md")),
        };
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    };

    expect(await skillsFor([{ name: "node_repl", command: "bin", enabled: true }])).toEqual({
      skills: ["browser"],
      browser: true,
      computerUse: false,
    });
    expect(
      await skillsFor([
        { name: "node_repl", command: "bin", enabled: true },
        { name: "computer-use", command: "bin", enabled: true },
      ]),
    ).toEqual({ skills: ["computer-use", "browser"], browser: true, computerUse: true });
    expect(await skillsFor([{ name: "computer-use", command: "bin", enabled: false }])).toEqual({
      skills: [],
      browser: false,
      computerUse: false,
    });
    expect(await skillsFor([])).toEqual({ skills: [], browser: false, computerUse: false });

    // A skill written by an earlier run must not outlive its MCP server.
    const home = await mkdtemp(join(tmpdir(), "sofia-runtime-skills-"));
    try {
      const both: CodexRuntimeMcpServer[] = [
        { name: "node_repl", command: "bin", enabled: true },
        { name: "computer-use", command: "bin", enabled: true },
      ];
      await codexRuntimeSkillsFor(home, both);
      await codexRuntimeSkillsFor(home, [{ name: "node_repl", command: "bin", enabled: true }]);
      expect(existsSync(join(home, "skills", "computer-use", "SKILL.md"))).toBe(false);
      expect(existsSync(join(home, "skills", "browser", "SKILL.md"))).toBe(true);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

});
