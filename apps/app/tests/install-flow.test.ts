import { describe, expect, test } from "bun:test";

import {
  classifyInstallCandidate,
  installTargets,
  isMcpInstall,
  planInstall,
} from "../src/react-app/domains/connections/install-flow";

describe("classifyInstallCandidate", () => {
  test("keeps remote and local MCP servers on the MCP path", () => {
    expect(classifyInstallCandidate({ name: "Linear", type: "remote", url: "https://mcp.linear.app/sse" })).toMatchObject({
      kind: "mcp-remote",
      mcp: true,
    });
    expect(classifyInstallCandidate({
      name: "Filesystem",
      type: "local",
      command: ["npx", "-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
    })).toMatchObject({ kind: "mcp-local", mcp: true });
  });

  test("recognizes the skills CLI so it is not written as an MCP server", () => {
    const cases: string[][] = [
      ["npx", "skills", "add", "remotion-dev/skills"],
      ["npx", "-y", "skills@latest", "add", "remotion-dev/skills"],
      ["skills", "add", "remotion-dev/skills"],
      ["pnpm", "dlx", "skills", "add", "remotion-dev/skills"],
      ["npm", "exec", "--", "skills", "add", "remotion-dev/skills"],
      ["FOO=bar", "npx", "skills", "add", "remotion-dev/skills"],
    ];

    for (const command of cases) {
      expect(classifyInstallCandidate({ name: "video-maker", type: "local", command })).toMatchObject({
        kind: "skill",
        reference: "remotion-dev/skills",
        mcp: false,
      });
    }
  });

  test("does not mistake unrelated npx packages for the skills CLI", () => {
    expect(classifyInstallCandidate({ name: "Server", type: "local", command: ["npx", "rimraf", "add"] })).toMatchObject({
      kind: "mcp-local",
    });
    expect(classifyInstallCandidate({ name: "Server", type: "local", command: ["node", "/opt/skills/add/index.js"] })).toMatchObject({
      kind: "mcp-local",
    });
  });

  test("recognizes plugin bundle references", () => {
    expect(classifyInstallCandidate({
      name: "Remotion",
      url: "/Users/me/plugins/remotion/.sofia-plugin/plugin.json",
    })).toMatchObject({ kind: "plugin", mcp: false });
  });

  test("reports an empty candidate as unknown", () => {
    expect(classifyInstallCandidate({ name: "Nothing" })).toMatchObject({ kind: "unknown", mcp: false });
  });
});

describe("installTargets", () => {
  test("maps global and project scopes to the engine's config layers", () => {
    expect(installTargets("global")).toEqual({
      scope: "global",
      configPath: "~/.sofia/config.toml",
      skillsDir: "~/.sofia/skills",
      pluginsDir: "~/.sofia/plugins",
    });
    expect(installTargets("project")).toEqual({
      scope: "project",
      configPath: ".sofia/config.toml",
      skillsDir: ".sofia/skills",
      pluginsDir: ".sofia/plugins",
    });
  });
});

describe("planInstall", () => {
  test("blocks a skill package before it reaches config", () => {
    const plan = planInstall({ name: "video-maker", type: "local", command: ["npx", "skills", "add", "remotion-dev/skills"] });
    expect(plan.issues).toContain("not_an_mcp_server");
    expect(isMcpInstall(plan)).toBe(false);
  });

  test("accepts a local MCP command but flags that it is unverified", () => {
    const plan = planInstall({ name: "Filesystem", type: "local", command: ["npx", "-y", "@modelcontextprotocol/server-filesystem"] });
    expect(plan.issues).toEqual([]);
    expect(plan.warnings).toHaveLength(1);
    expect(isMcpInstall(plan)).toBe(true);
  });

  test("rejects a command that starts with a flag", () => {
    expect(planInstall({ name: "Broken", type: "local", command: ["--yes", "server"] }).issues)
      .toContain("mcp_command_must_start_with_executable");
  });

  test("requires a name and a remote URL", () => {
    expect(planInstall({ name: "  ", type: "remote", url: "https://example.com/mcp" }).issues).toContain("name_required");
    expect(planInstall({ name: "Linear", type: "remote" }).issues).toContain("mcp_url_required");
  });

  test("records the requested scope on the plan", () => {
    const plan = planInstall({ name: "Linear", type: "remote", url: "https://mcp.linear.app/sse" }, "project");
    expect(plan.scope).toBe("project");
    expect(plan.targets.configPath).toBe(".sofia/config.toml");
  });
});
