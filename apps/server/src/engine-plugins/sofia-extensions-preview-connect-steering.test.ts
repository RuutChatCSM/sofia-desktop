import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  composeSofiaExtensionDiscoveryInstruction,
  composeSkillAuthoringInstruction,
  composeSteeringFromEngineMcpStatus,
  SOFIA_CLOUD_CONNECTION_INSTRUCTION,
  SOFIA_CLOUD_SKILL_AUTHORING_INSTRUCTION,
  SOFIA_CONNECT_DISABLED_INSTRUCTION,
  SOFIA_CONNECT_SIGN_IN_INSTRUCTION,
  SOFIA_EXTENSION_DISCOVERY_INSTRUCTION,
  SOFIA_LOCAL_SKILL_AUTHORING_INSTRUCTION,
  resetSofiaExtensionDiscoveryInstructionCacheForTests,
  resolveSofiaExtensionDiscoveryInstruction,
  type SofiaEngineMcpStatusClient,
  type SofiaExtensionConnectState,
} from "./sofia-extensions-preview-steering.js";

type CloudHealth = NonNullable<SofiaExtensionConnectState["cloudHealth"]>;
type CloudFailure = NonNullable<CloudHealth["firstFailure"]>;

const originalServerUrl = process.env.SOFIA_SERVER_URL;
const originalServerToken = process.env.SOFIA_SERVER_TOKEN;

const UNCHANGED_EXTENSION_DISCOVERY_INSTRUCTION =
  "If the user asks for something you cannot do with obvious built-in tools, check Sofia App extensions before saying the capability is unavailable. Use sofia_query with id extension.actions to inspect available extension actions, then sofia_execute with id extension.call for the matching action.";

beforeEach(() => {
  resetSofiaExtensionDiscoveryInstructionCacheForTests();
});

afterEach(() => {
  resetSofiaExtensionDiscoveryInstructionCacheForTests();
  if (originalServerUrl === undefined) delete process.env.SOFIA_SERVER_URL;
  else process.env.SOFIA_SERVER_URL = originalServerUrl;
  if (originalServerToken === undefined) delete process.env.SOFIA_SERVER_TOKEN;
  else process.env.SOFIA_SERVER_TOKEN = originalServerToken;
});

function health(overrides: Partial<NonNullable<SofiaExtensionConnectState["cloudHealth"]>> = {}): NonNullable<SofiaExtensionConnectState["cloudHealth"]> {
  return {
    usable: true,
    usableByCurrentModel: true,
    phase: "ready",
    workspace: { id: "ws_1", directory: "/tmp/ws_1" },
    desired: { present: true, revision: "rev_ready" },
    firstFailure: null,
    ...overrides,
  };
}

function failure(code: string, overrides: Partial<CloudFailure> = {}): CloudFailure {
  return {
    code,
    stage: overrides.stage ?? "test",
    recommendedAction: overrides.recommendedAction ?? "Check Settings → Connect.",
    message: overrides.message ?? "test failure",
  };
}

function expectNoDegradedSteering(instruction: string): void {
  expect(instruction).not.toMatch(/not ready/i);
  expect(instruction).not.toContain("Repair and test");
  expect(instruction).not.toContain("Do not use Sofia App documentation tools");
  expect(instruction).not.toContain("Do not substitute docs");
  expect(instruction).not.toContain("as a substitute for performing an action against a connected service");
  expect(instruction).not.toMatch(/do NOT use/i);
  expect(instruction).not.toMatch(/Do not try/);
}

function state(cloudHealth: SofiaExtensionConnectState["cloudHealth"]): SofiaExtensionConnectState {
  return {
    connectEnabled: true,
    connectCatalogEnabled: true,
    cloudMcpPresent: cloudHealth?.usable === true,
    cloudHealth,
    workspace: { resolution: "resolved", id: "ws_1", directory: "/tmp/ws_1" },
    googleWorkspace: { legacyConfigured: false },
  };
}

function engineMcpClient(result: unknown, requests: unknown[] = []): SofiaEngineMcpStatusClient {
  return {
    mcp: {
      status: async (request) => {
        requests.push(request);
        return result;
      },
    },
  };
}

describe("composeSteeringFromEngineMcpStatus", () => {
  test("maps engine MCP statuses to steering instructions", () => {
    expect(composeSteeringFromEngineMcpStatus("connected")).toBe(SOFIA_CLOUD_CONNECTION_INSTRUCTION);
    expect(composeSteeringFromEngineMcpStatus("disabled")).toBe(SOFIA_CONNECT_DISABLED_INSTRUCTION);
    expect(composeSteeringFromEngineMcpStatus("needs_auth")).toBe(SOFIA_CONNECT_SIGN_IN_INSTRUCTION);
    expect(composeSteeringFromEngineMcpStatus("needs_client_registration")).toBe(SOFIA_CONNECT_SIGN_IN_INSTRUCTION);
    expect(composeSteeringFromEngineMcpStatus("failed")).toBe(SOFIA_EXTENSION_DISCOVERY_INSTRUCTION);
    expect(composeSteeringFromEngineMcpStatus("starting")).toBe(SOFIA_EXTENSION_DISCOVERY_INSTRUCTION);
    expect(composeSteeringFromEngineMcpStatus(undefined)).toBe(SOFIA_EXTENSION_DISCOVERY_INSTRUCTION);
  });
});

describe("composeSofiaExtensionDiscoveryInstruction", () => {
  test("keeps the fallback instruction byte-identical when state is unavailable or generic discovery is gated", () => {
    expect(SOFIA_EXTENSION_DISCOVERY_INSTRUCTION).toBe(UNCHANGED_EXTENSION_DISCOVERY_INSTRUCTION);
    expect(composeSofiaExtensionDiscoveryInstruction(null)).toBe(UNCHANGED_EXTENSION_DISCOVERY_INSTRUCTION);
    expect(composeSofiaExtensionDiscoveryInstruction({ ...state(null), connectCatalogEnabled: false })).toBe(UNCHANGED_EXTENSION_DISCOVERY_INSTRUCTION);
  });

  test("keeps fallback when only legacy Google Workspace is configured", () => {
    expect(composeSofiaExtensionDiscoveryInstruction({ ...state(null), googleWorkspace: { legacyConfigured: true } })).toBe(UNCHANGED_EXTENSION_DISCOVERY_INSTRUCTION);
  });

  test("steers ready Connect users to verified sofia-cloud capabilities first", () => {
    expect(SOFIA_CLOUD_CONNECTION_INSTRUCTION).toContain("verified ready for this exact workspace/model");
    expect(SOFIA_CLOUD_CONNECTION_INSTRUCTION).toContain("use sofia-cloud_search_capabilities");
    expect(SOFIA_CLOUD_CONNECTION_INSTRUCTION).toContain("available_skills");
    expect(SOFIA_CLOUD_CONNECTION_INSTRUCTION).not.toContain("Skill creation:");
    expect(SOFIA_CLOUD_CONNECTION_INSTRUCTION).not.toContain("Gmail");
    expect(SOFIA_CLOUD_CONNECTION_INSTRUCTION).not.toContain("image generation");
    expect(SOFIA_CLOUD_CONNECTION_INSTRUCTION).toContain("relay connectionStatus.action exactly");
    expect(SOFIA_CLOUD_CONNECTION_INSTRUCTION).toContain("results are live, not cached");
    expect(composeSofiaExtensionDiscoveryInstruction(state(health()))).toBe(SOFIA_CLOUD_CONNECTION_INSTRUCTION);
    expect(composeSofiaExtensionDiscoveryInstruction({ ...state(health()), connectCatalogEnabled: false })).toBe(SOFIA_CLOUD_CONNECTION_INSTRUCTION);
    expect(composeSofiaExtensionDiscoveryInstruction({ ...state(health()), googleWorkspace: { legacyConfigured: true } })).toBe(SOFIA_CLOUD_CONNECTION_INSTRUCTION);
  });

  test("selects one compact skill-authoring prompt from verified Cloud access", () => {
    expect(composeSkillAuthoringInstruction(SOFIA_CLOUD_CONNECTION_INSTRUCTION)).toEqual({
      mode: "cloud",
      prompt: SOFIA_CLOUD_SKILL_AUTHORING_INSTRUCTION,
    });
    expect(SOFIA_CLOUD_SKILL_AUTHORING_INSTRUCTION).toContain("Skill creation: Cloud");
    expect(SOFIA_CLOUD_SKILL_AUTHORING_INSTRUCTION).toContain("retrieve and follow the listed create-skill remote skill");
    expect(SOFIA_CLOUD_SKILL_AUTHORING_INSTRUCTION).toContain("sofia-cloud_execute_capability");
    expect(SOFIA_CLOUD_SKILL_AUTHORING_INSTRUCTION).toContain("exact <capability>");
    expect(SOFIA_CLOUD_SKILL_AUTHORING_INSTRUCTION).toContain("Sofia Cloud as a private plugin");
    expect(SOFIA_CLOUD_SKILL_AUTHORING_INSTRUCTION).toContain("use share-plugin when the user wants a specific person or team to use a skill");
    expect(SOFIA_CLOUD_SKILL_AUTHORING_INSTRUCTION).toContain("add-to-marketplace");
    expect(SOFIA_CLOUD_SKILL_AUTHORING_INSTRUCTION).toContain("add-user-to-marketplace");
    expect(SOFIA_CLOUD_SKILL_AUTHORING_INSTRUCTION).toContain("workspace-local skill");
    expect(SOFIA_CLOUD_SKILL_AUTHORING_INSTRUCTION).toContain("Do not create both copies");
    expect(SOFIA_CLOUD_SKILL_AUTHORING_INSTRUCTION).not.toContain("Skill creation: Local");

    for (const instruction of [
      SOFIA_EXTENSION_DISCOVERY_INSTRUCTION,
      SOFIA_CONNECT_SIGN_IN_INSTRUCTION,
      SOFIA_CONNECT_DISABLED_INSTRUCTION,
    ]) {
      expect(composeSkillAuthoringInstruction(instruction)).toEqual({
        mode: "local",
        prompt: SOFIA_LOCAL_SKILL_AUTHORING_INSTRUCTION,
      });
    }
    expect(SOFIA_LOCAL_SKILL_AUTHORING_INSTRUCTION).toContain("Skill creation: Local");
    expect(SOFIA_LOCAL_SKILL_AUTHORING_INSTRUCTION).toContain("only when the user requests one");
    expect(SOFIA_LOCAL_SKILL_AUTHORING_INSTRUCTION).toContain(".sofia/skills/<skill-name>/SKILL.md");
    expect(SOFIA_LOCAL_SKILL_AUTHORING_INSTRUCTION).not.toContain("Skill creation: Cloud");
  });

  test("keeps neutral steering when provider projection is missing", () => {
    const instruction = composeSofiaExtensionDiscoveryInstruction(state(health({
      usable: true,
      usableByCurrentModel: false,
      phase: "provider_projection_missing",
      firstFailure: {
        code: "provider_tool_projection_missing",
        stage: "provider_projection",
        recommendedAction: "Update Sofia App",
        message: "missing",
      },
    })));

    expect(instruction).toBe(SOFIA_EXTENSION_DISCOVERY_INSTRUCTION);
  });

  test("uses neutral, signed-out, and disabled branches", () => {
    const neutral = composeSofiaExtensionDiscoveryInstruction({ ...state(health({
      usable: false,
      phase: "cloud_tools_missing",
      firstFailure: {
        code: "cloud_tools_missing",
        stage: "tool_registration",
        recommendedAction: "Run reconcile",
        message: "missing",
      },
    })), connectCatalogEnabled: false });
    expect(neutral).toBe(SOFIA_EXTENSION_DISCOVERY_INSTRUCTION);

    expect(composeSofiaExtensionDiscoveryInstruction({ ...state(health({
      usable: false,
      phase: "missing_desired",
      desired: { present: false, revision: null },
      firstFailure: {
        code: "cloud_mcp_missing",
        stage: "desired_config",
        recommendedAction: "Connect Sofia Cloud",
        message: "missing",
      },
    })), connectCatalogEnabled: false })).toBe(SOFIA_CONNECT_SIGN_IN_INSTRUCTION);

    expect(composeSofiaExtensionDiscoveryInstruction({ ...state(health({
      usable: false,
      phase: "engine_disabled",
      firstFailure: {
        code: "cloud_mcp_disabled",
        stage: "engine_delivery",
        recommendedAction: "Enable",
        message: "disabled",
      },
    })), connectCatalogEnabled: false })).toBe(SOFIA_CONNECT_DISABLED_INSTRUCTION);
  });

  test("keeps neutral steering for probe-side server failures", () => {
    expect(composeSofiaExtensionDiscoveryInstruction(state(health({
      usable: false,
      phase: "ready",
      engine: { status: "connected" },
      firstFailure: {
        code: "probe_unreachable",
        stage: "tool_registration",
        recommendedAction: "Check network",
        message: "probe failed",
      },
    })))).toBe(SOFIA_EXTENSION_DISCOVERY_INSTRUCTION);

    expect(composeSofiaExtensionDiscoveryInstruction(state(health({
      usable: false,
      phase: "cloud_tools_missing",
      engine: { status: "connected" },
      firstFailure: {
        code: "cloud_tools_missing",
        stage: "tool_registration",
        recommendedAction: "Run reconcile",
        message: "missing",
      },
    })))).toBe(SOFIA_EXTENSION_DISCOVERY_INSTRUCTION);
  });

  test("keeps neutral steering for cloud_tools_missing regardless of server engine health", () => {
    const withoutEngine = composeSofiaExtensionDiscoveryInstruction(state(health({
      usable: false,
      phase: "cloud_tools_missing",
      firstFailure: {
        code: "cloud_tools_missing",
        stage: "tool_registration",
        recommendedAction: "Run reconcile",
        message: "missing",
      },
    })));
    const failedEngine = composeSofiaExtensionDiscoveryInstruction(state(health({
      usable: false,
      phase: "cloud_tools_missing",
      engine: { status: "failed" },
      firstFailure: {
        code: "cloud_tools_missing",
        stage: "tool_registration",
        recommendedAction: "Run reconcile",
        message: "missing",
      },
    })));

    expect(withoutEngine).toBe(SOFIA_EXTENSION_DISCOVERY_INSTRUCTION);
    expect(failedEngine).toBe(SOFIA_EXTENSION_DISCOVERY_INSTRUCTION);
  });

  test("treats unknown workspace as neutral instead of borrowing another workspace", () => {
    const instruction = composeSofiaExtensionDiscoveryInstruction({
      ...state(null),
      workspace: { resolution: "unknown", id: null, directory: "/tmp/unknown", reason: "No workspace has this exact Sofia engine directory" },
    });
    expect(instruction).toBe(SOFIA_EXTENSION_DISCOVERY_INSTRUCTION);
  });

  test("never emits degraded wording or no-tool-use guidance", () => {
    const engineStatuses: Array<string | undefined> = [
      "connected",
      "disabled",
      "needs_auth",
      "needs_client_registration",
      "failed",
      "starting",
      undefined,
    ];
    for (const status of engineStatuses) {
      expectNoDegradedSteering(composeSteeringFromEngineMcpStatus(status));
    }

    const fallbackStates: SofiaExtensionConnectState[] = [
      state(health()),
      state(health({ usableByCurrentModel: null })),
      state(health({
        usableByCurrentModel: false,
        phase: "provider_projection_missing",
        firstFailure: failure("provider_tool_projection_missing"),
      })),
      state(health({
        usable: false,
        phase: "engine_disabled",
        firstFailure: failure("cloud_mcp_disabled"),
      })),
      state(health({
        usable: false,
        phase: "missing_desired",
        desired: { present: false, revision: null },
        firstFailure: failure("cloud_desired_missing"),
      })),
      state(health({
        usable: false,
        phase: "missing_mcp",
        firstFailure: failure("cloud_mcp_missing"),
      })),
      state(health({
        usable: false,
        phase: "probe_unreachable",
        firstFailure: failure("probe_unreachable"),
      })),
      state(health({
        usable: false,
        phase: "cloud_tools_missing",
        firstFailure: failure("cloud_tools_missing"),
      })),
      { ...state(null), workspace: { resolution: "unknown", id: null, directory: "/tmp/unknown" } },
      { ...state(null), connectCatalogEnabled: false },
      { ...state(null), googleWorkspace: { legacyConfigured: true } },
      state(null),
    ];
    for (const fallbackState of fallbackStates) {
      expectNoDegradedSteering(composeSofiaExtensionDiscoveryInstruction(fallbackState));
    }
  });
});

describe("resolveSofiaExtensionDiscoveryInstruction", () => {
  test("uses engine connected status without fetching server connect state", async () => {
    const requests: unknown[] = [];
    const client = engineMcpClient({ data: { "sofia-cloud": { status: "connected" } } }, requests);
    let serverFetchCalls = 0;
    const serverFetch = async (): Promise<Response> => {
      serverFetchCalls += 1;
      return Response.json({ message: "unexpected" }, { status: 500 });
    };

    const instruction = await resolveSofiaExtensionDiscoveryInstruction(
      { context: { directory: "/tmp/ws_1" } },
      serverFetch,
      { client, directory: "/tmp/factory" },
    );

    expect(instruction).toBe(SOFIA_CLOUD_CONNECTION_INSTRUCTION);
    expect(requests).toEqual([{ query: { directory: "/tmp/ws_1" } }]);
    expect(serverFetchCalls).toBe(0);
  });

  test("uses engine auth-needed status without fetching server connect state", async () => {
    const client = engineMcpClient({ data: { "sofia-cloud": { status: "needs_auth" } } });
    let serverFetchCalls = 0;
    const serverFetch = async (): Promise<Response> => {
      serverFetchCalls += 1;
      return Response.json({ message: "unexpected" }, { status: 500 });
    };

    expect(await resolveSofiaExtensionDiscoveryInstruction({}, serverFetch, { client })).toBe(SOFIA_CONNECT_SIGN_IN_INSTRUCTION);
    expect(serverFetchCalls).toBe(0);
  });

  test("fails open without server fetch when engine status lookup errors", async () => {
    const client: SofiaEngineMcpStatusClient = {
      mcp: {
        status: async () => {
          throw new Error("engine unavailable");
        },
      },
    };
    let serverFetchCalls = 0;
    const serverFetch = async (): Promise<Response> => {
      serverFetchCalls += 1;
      return Response.json({ message: "unexpected" }, { status: 500 });
    };

    expect(await resolveSofiaExtensionDiscoveryInstruction({}, serverFetch, { client })).toBe(UNCHANGED_EXTENSION_DISCOVERY_INSTRUCTION);
    expect(serverFetchCalls).toBe(0);
  });

  test("fails open without server fetch when engine has an unknown sofia-cloud status", async () => {
    const client = engineMcpClient({ data: { "sofia-cloud": { status: "starting" } } });
    let serverFetchCalls = 0;
    const serverFetch = async (): Promise<Response> => {
      serverFetchCalls += 1;
      return Response.json({ message: "unexpected" }, { status: 500 });
    };

    expect(await resolveSofiaExtensionDiscoveryInstruction({}, serverFetch, { client })).toBe(UNCHANGED_EXTENSION_DISCOVERY_INSTRUCTION);
    expect(serverFetchCalls).toBe(0);
  });

  test("falls back to server connect state when engine has no sofia-cloud entry", async () => {
    process.env.SOFIA_SERVER_URL = "http://sofia.test";
    process.env.SOFIA_SERVER_TOKEN = "test-token";
    const client = engineMcpClient({ data: { other: { status: "connected" } } });
    let serverFetchCalls = 0;
    const serverFetch = async (): Promise<Response> => {
      serverFetchCalls += 1;
      return Response.json({
        ok: true,
        schemaVersion: 1,
        connectEnabled: true,
        connectCatalogEnabled: true,
        cloudMcpPresent: true,
        cloudHealth: health(),
        workspace: { resolution: "resolved", id: "ws_1", directory: "/tmp/ws_1" },
        googleWorkspace: { legacyConfigured: false },
      });
    };

    expect(await resolveSofiaExtensionDiscoveryInstruction({ context: { directory: "/tmp/ws_1" } }, serverFetch, { client })).toBe(SOFIA_CLOUD_CONNECTION_INSTRUCTION);
    expect(serverFetchCalls).toBe(1);
  });

  test("fetches verified health for the current directory/model without caching stale failures", async () => {
    process.env.SOFIA_SERVER_URL = "http://sofia.test/";
    process.env.SOFIA_SERVER_TOKEN = "test-token";
    const urls: string[] = [];
    const authorizations: Array<string | null> = [];
    let calls = 0;
    const fakeFetch = async (url: string, init?: RequestInit): Promise<Response> => {
      calls += 1;
      urls.push(url);
      authorizations.push(new Headers(init?.headers).get("authorization"));
      return Response.json({
        ok: true,
        schemaVersion: 1,
        connectEnabled: true,
        connectCatalogEnabled: true,
        cloudMcpPresent: calls > 1,
        cloudHealth: calls > 1 ? health() : health({
          usable: false,
          phase: "cloud_tools_missing",
          firstFailure: {
            code: "cloud_tools_missing",
            stage: "tool_registration",
            recommendedAction: "Run reconcile",
            message: "missing",
          },
        }),
        workspace: { resolution: "resolved", id: "ws_1", directory: "/tmp/ws_1" },
        googleWorkspace: { legacyConfigured: false },
      });
    };

    const input = {
      context: { directory: "/tmp/ws_1" },
      model: { providerID: "anthropic", modelID: "claude-sonnet-4" },
    };
    expect(await resolveSofiaExtensionDiscoveryInstruction(input, fakeFetch)).toBe(UNCHANGED_EXTENSION_DISCOVERY_INSTRUCTION);
    expect(await resolveSofiaExtensionDiscoveryInstruction(input, fakeFetch)).toBe(SOFIA_CLOUD_CONNECTION_INSTRUCTION);
    expect(calls).toBe(2);
    expect(urls).toEqual([
      "http://sofia.test/experimental/connect/state?directory=%2Ftmp%2Fws_1&provider=anthropic&model=claude-sonnet-4",
      "http://sofia.test/experimental/connect/state?directory=%2Ftmp%2Fws_1&provider=anthropic&model=claude-sonnet-4",
    ]);
    expect(authorizations).toEqual(["Bearer test-token", "Bearer test-token"]);
  });

  test("passes workspace id and worktree from plugin context", async () => {
    process.env.SOFIA_SERVER_URL = "http://sofia.test";
    process.env.SOFIA_SERVER_TOKEN = "test-token";
    let requested = "";
    const fakeFetch = async (url: string): Promise<Response> => {
      requested = url;
      return Response.json({
        ok: true,
        schemaVersion: 1,
        connectEnabled: true,
        connectCatalogEnabled: true,
        cloudMcpPresent: true,
        cloudHealth: health(),
        workspace: { resolution: "resolved", id: "ws_2", directory: "/tmp/worktree" },
        googleWorkspace: { legacyConfigured: false },
      });
    };

    await resolveSofiaExtensionDiscoveryInstruction({ context: { workspaceId: "ws_2", worktree: "/tmp/worktree" } }, fakeFetch);
    expect(requested).toBe("http://sofia.test/experimental/connect/state?workspaceId=ws_2&directory=%2Ftmp%2Fworktree");
  });

  test("fails open when connect state fetching or parsing fails", async () => {
    process.env.SOFIA_SERVER_URL = "http://sofia.test";
    process.env.SOFIA_SERVER_TOKEN = "test-token";
    const failingFetch = async (): Promise<Response> => {
      throw new Error("network unavailable");
    };
    const invalidFetch = async (): Promise<Response> => Response.json({ ok: true });

    expect(await resolveSofiaExtensionDiscoveryInstruction({}, failingFetch)).toBe(UNCHANGED_EXTENSION_DISCOVERY_INSTRUCTION);
    expect(await resolveSofiaExtensionDiscoveryInstruction({}, invalidFetch)).toBe(UNCHANGED_EXTENSION_DISCOVERY_INSTRUCTION);
  });
});
