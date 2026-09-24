import { beforeEach, describe, expect, test } from "bun:test";

import type { DenMcpToken } from "../src/app/lib/den";
import type { SofiaCloudMcpFailure, SofiaCloudMcpHealth, SofiaCloudMcpReconcilePayload } from "../src/app/lib/sofia-server";
import {
  __setCloudMcpUserStateStorageForTest,
  getCloudMcpScopeKey,
  readCloudMcpSyncMarker,
  writeCloudMcpSyncMarker,
} from "../src/react-app/domains/connections/cloud-mcp-user-state";
import {
  buildSofiaCloudMcpReconcilePayload,
  cloudMcpDisplaySummary,
  cloudMcpFailureStageLabel,
  isCloudMcpAuthTokenFailure,
  isCloudMcpAuthTokenFailureCode,
  runSofiaCloudMcpEngineRefresh,
  runSofiaCloudMcpReconciler,
} from "../src/react-app/domains/connections/cloud-mcp-reconciler";

const NOW = Date.parse("2026-07-09T12:00:00.000Z");
const scope = {
  denBaseUrl: "https://app.sofia.test",
  serverBaseUrl: "https://worker.sofia.test",
  orgId: "org_1",
  workspaceId: "ws_1",
};
const context = {
  ...scope,
  denAuthToken: "den-session-token",
  providerModel: { provider: "sofia", model: "gpt-5" },
};
const token: DenMcpToken = {
  token: "owt_mcp_secret_token",
  appHostToken: "owt_mcp_private_app_host_token",
  expiresAt: new Date(NOW + 7 * 24 * 60 * 60 * 1000).toISOString(),
  appHostExpiresAt: new Date(NOW + 7 * 24 * 60 * 60 * 1000).toISOString(),
  organizationId: "org_1",
  scopes: ["mcp:read", "mcp:write"],
  resource: "https://api.sofia.test/mcp",
};

function installStorageStub() {
  const values = new Map<string, string>();
  __setCloudMcpUserStateStorageForTest({
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  });
}

function failure(code: string): SofiaCloudMcpFailure {
  return {
    code,
    stage: "engine_status",
    retryable: false,
    recommendedAction: "fix it",
    message: "failed",
  };
}

function health(input: { usable: boolean; failure?: SofiaCloudMcpFailure | null; projectionChecked?: boolean }): SofiaCloudMcpHealth {
  const usable = input.usable;
  const projectionChecked = input.projectionChecked ?? usable;
  return {
    schemaVersion: 1,
    phase: usable ? "ready" : "engine_failed",
    usable,
    usableByCurrentModel: projectionChecked ? usable : null,
    connectCatalogEnabled: true,
    workspace: { id: scope.workspaceId, type: "local", directory: "/workspace", path: "/workspace" },
    desired: {
      present: true,
      name: "sofia-cloud",
      revision: "rev_desired",
      config: null,
      token: { present: true, metadata: { expiresAt: token.expiresAt, scopes: "mcp:read mcp:write" } },
    },
    delivery: {
      state: usable ? "ready" : "pending",
      desiredRevision: "rev_desired",
      appliedRevision: usable ? "rev_desired" : null,
      updatedAt: NOW,
      appliedAt: usable ? NOW : null,
      lastAttemptAt: NOW,
    },
    engine: { status: usable ? "connected" : "failed" },
    tools: {
      expected: ["sofia-cloud_search_capabilities", "sofia-cloud_execute_capability"],
      present: usable ? ["sofia-cloud_search_capabilities", "sofia-cloud_execute_capability"] : [],
      missing: usable ? [] : ["sofia-cloud_search_capabilities"],
      direct: {
        checked: true,
        source: "mcp_tools_list",
        expected: ["search_capabilities", "execute_capability"],
        present: usable ? ["search_capabilities", "execute_capability"] : [],
        missing: usable ? [] : ["search_capabilities"],
      },
      providerProjection: {
        checked: projectionChecked,
        provider: "sofia",
        model: "gpt-5",
        source: "experimental_tool",
        present: usable ? ["sofia-cloud_search_capabilities", "sofia-cloud_execute_capability"] : [],
        missing: usable ? [] : ["sofia-cloud_execute_capability"],
      },
    },
    pluginCanaries: { expected: ["sofia_docs_search"], present: usable ? ["sofia_docs_search"] : [], missing: usable ? [] : ["sofia_docs_search"] },
    compatibility: {
      sofia: { serverVersion: "test", app: null },
      engine: { expectedVersion: "1.17.11", actualVersion: "1.17.11", probe: "ok" },
      pluginFileHashes: [],
      supportedFeatures: { dynamicMcp: true, directoryScoping: true, toolIds: true, providerToolProjection: projectionChecked, pluginCanaries: true },
      experimentalToolIds: {
        checked: true,
        expected: ["sofia-cloud_search_capabilities", "sofia-cloud_execute_capability"],
        present: usable ? ["sofia-cloud_search_capabilities", "sofia-cloud_execute_capability"] : [],
        missing: usable ? [] : ["sofia-cloud_execute_capability"],
        includesMcpTools: usable,
      },
      experimentalProviderTools: {
        checked: projectionChecked,
        provider: "sofia",
        model: "gpt-5",
        expected: ["sofia-cloud_search_capabilities", "sofia-cloud_execute_capability"],
        present: usable ? ["sofia-cloud_search_capabilities", "sofia-cloud_execute_capability"] : [],
        missing: usable ? [] : ["sofia-cloud_execute_capability"],
        includesMcpTools: projectionChecked ? usable : null,
      },
    },
    toolDenies: [],
    firstFailure: usable ? null : input.failure ?? failure("cloud_connection_failed"),
    checkedAt: new Date(NOW).toISOString(),
  };
}

describe("Sofia Cloud MCP reconciler", () => {
  beforeEach(() => installStorageStub());

  test("uses the minted web proxy resource instead of a stale direct API fallback", () => {
    const payload = buildSofiaCloudMcpReconcilePayload({
      context: {
        ...context,
        fallbackUrl: "https://api.sofia.test/mcp/agent",
      },
      token: {
        ...token,
        resource: "https://app.sofia.test/api/den/mcp",
      },
    });

    expect(payload?.config.url).toBe("https://app.sofia.test/api/den/mcp/agent");
  });

  test("keeps central search and execute working against an older Den without opening the App host", () => {
    const payload = buildSofiaCloudMcpReconcilePayload({
      context,
      token: {
        token: token.token,
        expiresAt: token.expiresAt,
        organizationId: token.organizationId,
        scopes: token.scopes,
        resource: token.resource,
      },
    });

    expect(payload?.config.headers).toEqual({ Authorization: `Bearer ${token.token}` });
    expect(payload?.appHostAuthorization).toBeUndefined();
  });

  test("Test now performs only GET health", async () => {
    const values = new Map<string, string>();
    let writes = 0;
    __setCloudMcpUserStateStorageForTest({
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        writes += 1;
        values.set(key, value);
      },
      removeItem: (key) => values.delete(key),
    });
    writeCloudMcpSyncMarker({ ...scope, expiresAt: token.expiresAt });
    writes = 0;
    let getCount = 0;
    let mintCount = 0;
    let postCount = 0;
    const result = await runSofiaCloudMcpReconciler({
      mode: "health",
      client: {
        baseUrl: scope.serverBaseUrl,
        getSofiaCloudMcpHealth: async () => {
          getCount += 1;
          return health({ usable: true });
        },
        reconcileSofiaCloudMcp: async () => {
          postCount += 1;
          return health({ usable: true });
        },
      },
      context,
      mintToken: async () => {
        mintCount += 1;
        return token;
      },
      refreshMarginMs: 24 * 60 * 60 * 1000,
    });

    expect(result.health?.usable).toBe(true);
    expect(getCount).toBe(1);
    expect(mintCount).toBe(0);
    expect(postCount).toBe(0);
    expect(writes).toBe(0);
  });

  test("Test now with probe asks the server for a direct endpoint verification", async () => {
    const probeOptionsSeen: Array<{ probe?: boolean } | undefined> = [];
    const client = {
      baseUrl: scope.serverBaseUrl,
      getSofiaCloudMcpHealth: async (
        _workspaceId: string,
        _providerModel?: unknown,
        options?: { probe?: boolean },
      ) => {
        probeOptionsSeen.push(options);
        return health({ usable: true });
      },
      reconcileSofiaCloudMcp: async () => health({ usable: true }),
    };

    await runSofiaCloudMcpReconciler({
      mode: "health",
      client,
      context,
      mintToken: async () => token,
      refreshMarginMs: 24 * 60 * 60 * 1000,
      probe: true,
    });
    await runSofiaCloudMcpReconciler({
      mode: "health",
      client,
      context,
      mintToken: async () => token,
      refreshMarginMs: 24 * 60 * 60 * 1000,
    });

    expect(probeOptionsSeen).toEqual([{ probe: true }, undefined]);
  });

  test("engine refresh maps the endpoint result and skips unsupported servers", async () => {
    const calls: Array<{ workspaceId: string; payload?: { provider?: string; model?: string; trigger?: string } }> = [];
    const refreshedHealth = health({ usable: true });
    const refresh = {
      performed: true,
      trigger: "desktop-engine-refresh",
      startedAt: new Date(NOW).toISOString(),
      finishedAt: new Date(NOW + 500).toISOString(),
      steps: [
        { step: "engine_disconnect", ok: true, latencyMs: 12 },
        { step: "reapply", ok: true, latencyMs: 480 },
      ],
    };
    const result = await runSofiaCloudMcpEngineRefresh({
      client: {
        baseUrl: scope.serverBaseUrl,
        getSofiaCloudMcpHealth: async () => refreshedHealth,
        reconcileSofiaCloudMcp: async () => refreshedHealth,
        refreshSofiaCloudMcpEngine: async (workspaceId, payload) => {
          calls.push({ workspaceId, payload });
          return { refresh, health: refreshedHealth };
        },
      },
      context,
    });

    expect(result.status).toBe("refreshed");
    expect(result.refresh?.steps.map((step) => step.step)).toEqual(["engine_disconnect", "reapply"]);
    expect(calls).toEqual([
      {
        workspaceId: scope.workspaceId,
        payload: { provider: "sofia", model: "gpt-5", trigger: "desktop-engine-refresh" },
      },
    ]);

    const failed = await runSofiaCloudMcpEngineRefresh({
      client: {
        baseUrl: scope.serverBaseUrl,
        getSofiaCloudMcpHealth: async () => refreshedHealth,
        reconcileSofiaCloudMcp: async () => refreshedHealth,
        refreshSofiaCloudMcpEngine: async () => ({
          refresh: { ...refresh, steps: [{ step: "engine_disconnect", ok: false, latencyMs: 3 }, { step: "reapply", ok: false, latencyMs: 9 }] },
          health: health({ usable: false }),
        }),
      },
      context,
    });
    expect(failed.status).toBe("failed");

    const skipped = await runSofiaCloudMcpEngineRefresh({
      client: {
        baseUrl: scope.serverBaseUrl,
        getSofiaCloudMcpHealth: async () => refreshedHealth,
        reconcileSofiaCloudMcp: async () => refreshedHealth,
      },
      context,
    });
    expect(skipped.status).toBe("skipped");
    expect(skipped.skippedReason).toBe("unsupported");
  });

  test("writes marker only when returned health is usable", async () => {
    const client = {
      baseUrl: scope.serverBaseUrl,
      getSofiaCloudMcpHealth: async () => health({ usable: false, failure: failure("cloud_status_missing") }),
      reconcileSofiaCloudMcp: async () => health({ usable: false, failure: failure("cloud_status_missing") }),
    };

    await runSofiaCloudMcpReconciler({ mode: "repair", client, context, mintToken: async () => token, force: true, refreshMarginMs: 1 });
    expect(readCloudMcpSyncMarker(scope)).toBeNull();

    await runSofiaCloudMcpReconciler({
      mode: "repair",
      client: { ...client, reconcileSofiaCloudMcp: async () => health({ usable: true }) },
      context,
      mintToken: async () => token,
      force: true,
      refreshMarginMs: 1,
    });
    expect(readCloudMcpSyncMarker(scope)?.expiresAt).toBe(token.expiresAt);
  });

  test("auth failures remint exactly once", async () => {
    let mintCount = 0;
    const posts: SofiaCloudMcpReconcilePayload[] = [];
    const result = await runSofiaCloudMcpReconciler({
      mode: "repair",
      client: {
        baseUrl: scope.serverBaseUrl,
        getSofiaCloudMcpHealth: async () => health({ usable: false }),
        reconcileSofiaCloudMcp: async (_workspaceId, payload) => {
          posts.push(payload);
          return posts.length === 1
            ? health({ usable: false, failure: failure("sofia_cloud_token_expired") })
            : health({ usable: true });
        },
      },
      context,
      mintToken: async () => {
        mintCount += 1;
        return { ...token, token: `owt_mcp_secret_${mintCount}` };
      },
      force: true,
      refreshMarginMs: 1,
    });

    expect(result.health?.usable).toBe(true);
    expect(mintCount).toBe(2);
    expect(posts).toHaveLength(2);
  });

  test("membership and scope failures do not retry", async () => {
    for (const code of ["sofia_cloud_membership_required", "sofia_cloud_scope_missing", "sofia_cloud_resource_forbidden"]) {
      expect(isCloudMcpAuthTokenFailureCode(code)).toBe(false);
    }
    let mintCount = 0;
    let postCount = 0;
    await runSofiaCloudMcpReconciler({
      mode: "repair",
      client: {
        baseUrl: scope.serverBaseUrl,
        getSofiaCloudMcpHealth: async () => health({ usable: false }),
        reconcileSofiaCloudMcp: async () => {
          postCount += 1;
          return health({ usable: false, failure: failure("sofia_cloud_membership_required") });
        },
      },
      context,
      mintToken: async () => {
        mintCount += 1;
        return token;
      },
      force: true,
      refreshMarginMs: 1,
    });

    expect(mintCount).toBe(1);
    expect(postCount).toBe(1);
  });

  test("expired first-party token codes count as auth failures", () => {
    // Field incident regression: the Den rejects an expired opaque bearer with
    // code `invalid_mcp_token`; the `_mcp_` infix defeated the substring check
    // and the remint retry never fired for ~7 days.
    expect(isCloudMcpAuthTokenFailureCode("invalid_mcp_token")).toBe(true);
    expect(isCloudMcpAuthTokenFailureCode("missing_mcp_token")).toBe(true);
    expect(isCloudMcpAuthTokenFailureCode("sofia_cloud_token_expired")).toBe(true);
    expect(isCloudMcpAuthTokenFailureCode("invalid_token")).toBe(true);
    // Exclusions still hold.
    expect(isCloudMcpAuthTokenFailureCode("sofia_cloud_client_registration_required")).toBe(false);
    expect(isCloudMcpAuthTokenFailureCode("membership_not_found")).toBe(false);
    expect(isCloudMcpAuthTokenFailureCode(null)).toBe(false);
  });

  test("auth aliases trigger the remint retry when the primary code is unrecognized", async () => {
    expect(isCloudMcpAuthTokenFailure({ code: "cloud_connection_failed", aliases: ["sofia_cloud_token_expired"] })).toBe(true);
    expect(isCloudMcpAuthTokenFailure({ code: "cloud_connection_failed", aliases: ["cloud_tools_missing"] })).toBe(false);
    expect(isCloudMcpAuthTokenFailure(null)).toBe(false);

    let mintCount = 0;
    const posts: SofiaCloudMcpReconcilePayload[] = [];
    const result = await runSofiaCloudMcpReconciler({
      mode: "repair",
      client: {
        baseUrl: scope.serverBaseUrl,
        getSofiaCloudMcpHealth: async () => health({ usable: false }),
        reconcileSofiaCloudMcp: async (_workspaceId, payload) => {
          posts.push(payload);
          return posts.length === 1
            ? health({ usable: false, failure: { ...failure("invalid_mcp_token"), aliases: ["sofia_cloud_token_expired"] } })
            : health({ usable: true });
        },
      },
      context,
      mintToken: async () => {
        mintCount += 1;
        return { ...token, token: `owt_mcp_secret_${mintCount}` };
      },
      force: true,
      refreshMarginMs: 1,
    });

    expect(result.health?.usable).toBe(true);
    expect(mintCount).toBe(2);
    expect(posts).toHaveLength(2);
  });

  test("dedupe key is scoped by deployment, server, workspace, and org without token", () => {
    const key = getCloudMcpScopeKey(scope);
    expect(key).toContain(scope.denBaseUrl);
    expect(key).toContain(scope.serverBaseUrl);
    expect(key).toContain(scope.workspaceId);
    expect(key).toContain(scope.orgId);
    expect(key).not.toContain("den-session-token");
    expect(getCloudMcpScopeKey({ ...scope, orgId: "org_2" })).not.toBe(key);
  });

  test("plain-language helpers map model projection and missing provider checks", () => {
    expect(cloudMcpFailureStageLabel({
      signedIn: true,
      orgSelected: true,
      health: health({ usable: false, failure: failure("provider_projection_missing") }),
    })).toBe("Current model can’t use Cloud tools");

    const canonicalProjectionFailure = {
      ...failure("provider_tool_projection_missing"),
      stage: "provider_projection" as const,
      recommendedAction: "Choose a model that can use Organization cloud tools",
    };
    expect(cloudMcpFailureStageLabel({
      signedIn: true,
      orgSelected: true,
      health: health({ usable: false, failure: canonicalProjectionFailure }),
    })).toBe("Current model can’t use Cloud tools");
    expect(cloudMcpDisplaySummary({
      signedIn: true,
      orgSelected: true,
      connecting: false,
      health: health({ usable: false, failure: canonicalProjectionFailure }),
    })).toMatchObject({
      statusLabel: "Degraded",
      stageLabel: "Current model can’t use Cloud tools",
      recommendedAction: "Choose a model that can use Organization cloud tools.",
    });

    const summary = cloudMcpDisplaySummary({
      signedIn: true,
      orgSelected: true,
      connecting: false,
      health: health({ usable: true, projectionChecked: false }),
    });
    expect(summary.statusLabel).toBe("Ready");
    expect(summary.recommendedAction).toContain("not checked");
  });

  test("missing desired config is degraded while explicit disabled config is disabled", () => {
    const missingDesired = {
      ...health({ usable: false, failure: { ...failure("cloud_mcp_missing"), stage: "desired_config" } }),
      desired: {
        present: false,
        name: "sofia-cloud",
        revision: null,
        config: null,
        token: { present: false, metadata: {} },
      },
    };
    const missingSummary = cloudMcpDisplaySummary({
      signedIn: true,
      orgSelected: true,
      connecting: false,
      health: missingDesired,
    });
    expect(missingSummary.statusLabel).toBe("Degraded");
    expect(missingSummary.stageLabel).toBe("Couldn’t apply Cloud access to this workspace");

    const disabledSummary = cloudMcpDisplaySummary({
      signedIn: true,
      orgSelected: true,
      connecting: false,
      health: {
        ...health({ usable: false, failure: { ...failure("cloud_mcp_disabled"), stage: "desired_config" } }),
        desired: {
          ...health({ usable: false }).desired,
          config: { enabled: false },
        },
      },
    });
    expect(disabledSummary.statusLabel).toBe("Disabled");
  });
});
