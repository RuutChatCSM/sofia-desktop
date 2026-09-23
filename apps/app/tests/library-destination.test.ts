import { describe, expect, test } from "bun:test";

import {
  COMPOSER_CONFIGURE_SECTION,
  LIBRARY_ROUTE_PATH,
  composerConfigureDestination,
  composerConfigureSectionForMenu,
  isLibraryAgent,
  isLibraryCommand,
  libraryAgentDetailId,
  libraryAgentsFromOpencode,
  libraryCommandDetailId,
  libraryCommandTriggers,
  libraryCommandsFromSlashOptions,
  libraryPathForSection,
    denLibraryPluginCreateRequest,
    libraryAddAction,
    libraryAddKindsForFilter,
    libraryPluginFileDisplayName,
    libraryPluginFileFallbackDetailId,
    libraryPluginFilePreferredDetailId,
    parseLibraryPluginFileDetailId,
    waitForListedLibraryPlugin,
    slugifyLibraryItemName,
} from "../src/react-app/domains/settings/library";

describe("library destination", () => {
  test("composer Configure opens the matching Library filter except for providers", () => {
    expect(composerConfigureDestination("agents")).toEqual({ kind: "library", path: "agents" });
    expect(composerConfigureDestination("commands")).toEqual({ kind: "library", path: "commands" });
    expect(composerConfigureDestination("skills")).toEqual({ kind: "library", path: "skills" });
    expect(composerConfigureDestination("mcps")).toEqual({ kind: "library", path: "mcps" });
    expect(composerConfigureDestination("plugins")).toEqual({ kind: "library", path: "plugins" });
    expect(composerConfigureDestination("connections")).toEqual({ kind: "library", path: "connections" });
    expect(composerConfigureDestination("extensions")).toEqual({
      kind: "library",
      path: LIBRARY_ROUTE_PATH,
    });
    expect(composerConfigureDestination("providers")).toEqual({
      kind: "settings",
      route: "/settings/ai",
    });
    expect(composerConfigureDestination(COMPOSER_CONFIGURE_SECTION)).toEqual({
      kind: "library",
      path: LIBRARY_ROUTE_PATH,
    });
  });

  test("composer + menu panes map onto Library section URLs", () => {
    expect(composerConfigureSectionForMenu("skills")).toBe("skills");
    expect(composerConfigureSectionForMenu("commands")).toBe("commands");
    expect(composerConfigureSectionForMenu("agents")).toBe("agents");
    expect(composerConfigureSectionForMenu("plugin:recruiting")).toBe("plugins");
    expect(composerConfigureSectionForMenu("mcps")).toBe("connections");
    expect(composerConfigureSectionForMenu("plugins")).toBe("plugins");
    expect(composerConfigureSectionForMenu("connections")).toBe("connections");
    expect(libraryPathForSection(composerConfigureSectionForMenu("skills"))).toBe("skills");
    expect(libraryPathForSection(composerConfigureSectionForMenu("connections"))).toBe("connections");
    expect(libraryPathForSection(composerConfigureSectionForMenu("mcps"))).toBe("connections");
  });

  test("Library commands exclude skill and MCP slash aliases", () => {
    expect(isLibraryCommand({ source: "command" })).toBe(true);
    expect(isLibraryCommand({})).toBe(true);
    expect(isLibraryCommand({ source: "skill" })).toBe(false);
    expect(isLibraryCommand({ source: "mcp" })).toBe(false);
    expect(
      libraryCommandsFromSlashOptions([
        { id: "cmd:release", name: "release", source: "command" },
        { id: "skill:brief", name: "brief", source: "skill" },
      ]).map((command) => command.name),
    ).toEqual(["release"]);
  });

  test("Library agents exclude hidden and subagent entries", () => {
    expect(isLibraryAgent({ name: "sofia" })).toBe(true);
    expect(isLibraryAgent({ name: "reviewer", hidden: true })).toBe(false);
    expect(isLibraryAgent({ name: "explore", mode: "subagent" })).toBe(false);
    expect(
      libraryAgentsFromOpencode([
        { name: "sofia" },
        { name: "hidden", hidden: true },
        { name: "explore", mode: "subagent" },
        { name: "writer", description: "Drafts" },
      ]).map((agent) => agent.name),
    ).toEqual(["sofia", "writer"]);
  });

  test("Library commands keep templates and slash triggers for detail", () => {
    const commands = libraryCommandsFromSlashOptions([
      {
        id: "cmd:release",
        name: "release",
        source: "command",
        template: "Ship the build",
        hints: ["ship it"],
        agent: "sofia",
      },
    ]);
    expect(commands[0]?.template).toBe("Ship the build");
    expect(libraryCommandTriggers(commands[0]!)).toEqual(["/release", "ship it"]);
    expect(libraryCommandDetailId(commands[0]!)).toBe("command:cmd:release");
  });

  test("Library agents keep prompt and mode for detail", () => {
    const agents = libraryAgentsFromOpencode([
      { name: "writer", description: "Drafts", prompt: "Write clearly.", mode: "primary", native: true },
    ]);
    expect(agents[0]?.prompt).toBe("Write clearly.");
    expect(libraryAgentDetailId(agents[0]!)).toBe("agent:writer");
  });

  test("Library Add matches the active filter", () => {
    expect(libraryAddKindsForFilter("skill")).toEqual(["skill"]);
    expect(libraryAddKindsForFilter("command")).toEqual(["command"]);
    expect(libraryAddKindsForFilter("agent")).toEqual(["agent"]);
    expect(libraryAddKindsForFilter("mcp")).toEqual(["mcp"]);
    expect(libraryAddKindsForFilter("plugin")).toEqual(["plugin"]);
    expect(libraryAddKindsForFilter("connection")).toEqual(["connection"]);
    expect(libraryAddKindsForFilter("app")).toEqual([]);
    expect(libraryAddKindsForFilter("all")).toEqual([
      "skill",
      "command",
      "agent",
      "mcp",
      "plugin",
      "connection",
    ]);
  });

  test("Library Add slugs names to kebab-case", () => {
    expect(slugifyLibraryItemName("Briefing Notes", "skill")).toBe("briefing-notes");
    expect(slugifyLibraryItemName("/Release", "command")).toBe("release");
    expect(slugifyLibraryItemName("  ", "agent")).toBe("agent");
  });

  test("Library Add creates on Den when signed in", () => {
    const signedIn = { cloudSignedIn: true };
    expect(libraryAddAction("skill", signedIn)).toEqual({ type: "den-modal", kind: "skill" });
    expect(libraryAddAction("plugin", signedIn)).toEqual({ type: "den-modal", kind: "plugin" });
    expect(libraryAddAction("mcp", signedIn)).toEqual({ type: "den-modal", kind: "mcp" });
    expect(libraryAddAction("connection", signedIn)).toEqual({ type: "den-url", kind: "connection" });
  });

  test("Library Add is unavailable when signed out", () => {
    const signedOut = { cloudSignedIn: false };
    expect(libraryAddAction("skill", signedOut)).toBeNull();
    expect(libraryAddAction("mcp", signedOut)).toBeNull();
    expect(libraryAddAction("plugin", signedOut)).toBeNull();
    expect(libraryAddAction("connection", signedOut)).toBeNull();
  });

  test("signed-in Library Add posts a Den plugin bundle", () => {
    const request = denLibraryPluginCreateRequest("skill", {
      name: "Briefing Notes",
      description: "Prepare a customer briefing.",
      instructions: "Look up the account first.",
    });
    expect(request.name).toBe("Briefing Notes");
    expect(request.marketplaceId).toBeUndefined();
    expect(request.orgWide).toBe(false);
    expect(request.components[0]?.type).toBe("skill");
    expect(request.components[0]?.input.metadata.name).toBe("briefing-notes");
    expect(request.components[0]?.input.rawSourceText).toContain("Look up the account first.");
  });

  test("Library Add MCP posts a Den remote server, not a local config", () => {
    const request = denLibraryPluginCreateRequest("mcp", {
      name: "Linear",
      description: "",
      instructions: "https://mcp.linear.app/mcp",
    });
    expect(request.components[0]?.type).toBe("mcp");
    expect(request.components[0]?.input.normalizedPayloadJson).toEqual({
      mcpServers: { linear: { type: "remote", url: "https://mcp.linear.app/mcp" } },
    });
  });

  test("Library Add plugin bundle keeps MCP servers and does not auto-publish", () => {
    const request = denLibraryPluginCreateRequest("plugin", {
      name: "Sales call prep",
      description: "Prep a call",
      instructions: "",
      components: [
        { kind: "skill", name: "briefing", description: "Brief the account", content: "Look up the account." },
        { kind: "mcp", name: "Linear", description: "", content: "https://mcp.linear.app/mcp" },
      ],
    });
    expect(request.marketplaceId).toBeUndefined();
    expect(request.components.map((component) => component.type)).toEqual(["skill", "mcp"]);
    expect(request.components[1]?.input.normalizedPayloadJson).toEqual({
      mcpServers: { linear: { type: "remote", url: "https://mcp.linear.app/mcp" } },
    });
  });

  test("plugin files map onto Library detail ids", () => {
    const skill = {
      configObjectId: "cfg_skill",
      objectType: "skill",
      title: "Customer research",
      skillName: "customer-research",
    };
    const command = {
      configObjectId: "cfg_cmd",
      objectType: "command",
      title: "brief",
    };
    const mcp = {
      configObjectId: "cfg_mcp",
      objectType: "mcp",
      title: "Linear",
    };
    expect(libraryPluginFileDisplayName(skill)).toBe("customer-research");
    expect(libraryPluginFilePreferredDetailId(skill)).toBe("skill:customer-research");
    expect(libraryPluginFilePreferredDetailId(command)).toBe("command:cmd:brief");
    expect(libraryPluginFilePreferredDetailId(mcp)).toBe("connect-mcp:Linear");
    expect(libraryPluginFileFallbackDetailId("plug_1", skill)).toBe("plugin:plug_1/file/cfg_skill");
    expect(parseLibraryPluginFileDetailId("plugin:plug_1/file/cfg_skill")).toEqual({
      pluginId: "plug_1",
      fileId: "cfg_skill",
    });
    expect(parseLibraryPluginFileDetailId("plugin:plug_1")).toBeNull();
  });

  test("waits until a created plugin appears in My Library", async () => {
    let calls = 0;
    const found = await waitForListedLibraryPlugin(
      async () => {
        calls += 1;
        return calls >= 2 ? [{ id: "plug_new" }] : [];
      },
      "plug_new",
      { attempts: 3, delayMs: 0 },
    );
    expect(found).toBe(true);
    expect(calls).toBe(2);
  });
});
