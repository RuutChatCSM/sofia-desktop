import { createHash } from "node:crypto";
import { z } from "zod";

import { readMcpResourceText, type McpFetch } from "./connect-mcp-transport.js";
import { readActivatedEnterpriseDenOrigin } from "./enterprise-den-origin.js";
import {
  readRuntimeMcpConfig,
  runtimeMcpMap,
  writeRuntimeWorkspaceEngineConfig,
} from "./runtime-engine-config-store.js";
import { externalFetch } from "./server-fetch.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";
import { createWorkspaceKvStore } from "./workspace-kv-store.js";

export const CONNECT_MCP_SERVER_INDEX_URI = "sofia://connect/mcp-servers/index.json";
export const CONNECT_MCP_SERVER_INDEX_SCHEMA_VERSION = "sofia.connect/mcp-servers/1";
export const CONNECT_MCP_APP_HOST_NAME_PREFIX = "sofia-app-host-connect-";
export const CONNECT_MCP_SERVER_NAME_PREFIX = "sofia-connect-";
export const CONNECT_MCP_APP_HOST_CAPABILITY_HEADER = "x-sofia-mcp-client-capabilities";
export const CONNECT_MCP_APP_HOST_CAPABILITY = "mcp-app-host-v1";

const BUILTIN_APP_HOST_CLOUD_ORIGINS = new Set([
  "https://sofia-api.ruut.chat",
  "https://sofia-app.ruut.chat",
  "https://api.sofia.software",
  "https://app.sofia.software",
]);

const BUILTIN_APP_HOST_GATEWAY_PROXY_ORIGINS = new Map([
  ["https://sofia-app.ruut.chat", "https://sofia-api.ruut.chat"],
  ["https://app.sofia.software", "https://api.sofia.software"],
]);

const indexSchema = z.object({
  schemaVersion: z.literal(CONNECT_MCP_SERVER_INDEX_SCHEMA_VERSION),
  servers: z.array(z.object({
    connectionId: z.string().min(1).max(160),
    name: z.string().min(1).max(255),
    description: z.string().max(1_024).nullable(),
    url: z.string().url().refine((value) => /^https?:\/\//.test(value), "MCP server URL must use HTTP(S)"),
  })).max(100),
});

const appHostCredentialSchema = z.object({
  authorization: z.string(),
  origin: z.string().url(),
});

export type SofiaConnectMcpServerIndex = z.infer<typeof indexSchema>;

const emptyIndex = (): SofiaConnectMcpServerIndex => ({
  schemaVersion: CONNECT_MCP_SERVER_INDEX_SCHEMA_VERSION,
  servers: [],
});

const appHostCatalogStore = createWorkspaceKvStore<SofiaConnectMcpServerIndex>({
  tableName: "connect_mcp_app_host_catalogs",
  valueColumn: "catalog_json",
  parse: (json) => {
    try {
      const parsed = indexSchema.safeParse(JSON.parse(json));
      return parsed.success ? parsed.data : emptyIndex();
    } catch {
      return emptyIndex();
    }
  },
  serialize: (value) => JSON.stringify(value),
});

type SofiaConnectMcpAppHostCredential = z.infer<typeof appHostCredentialSchema>;

const appHostAuthorizationStore = createWorkspaceKvStore<SofiaConnectMcpAppHostCredential | null>({
  tableName: "connect_mcp_app_host_authorizations",
  valueColumn: "authorization_json",
  parse: (json) => {
    try {
      const parsed = appHostCredentialSchema.safeParse(JSON.parse(json));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  },
  serialize: (value) => JSON.stringify(value),
});

function privateAppHostAuthorization(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length <= 8_192 && /^Bearer\s+[^\s,]+$/i.test(normalized) ? normalized : null;
}

function endpointOrigin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const endpoint = new URL(value);
    return endpoint.username || endpoint.password ? null : endpoint.origin;
  } catch {
    return null;
  }
}

function normalizeAppHostProxyUrl(
  cloudMcpUrl: unknown,
  server: SofiaConnectMcpServerIndex["servers"][number],
): string | null {
  if (typeof cloudMcpUrl !== "string") return null;
  let cloudEndpoint: URL;
  let serverEndpoint: URL;
  try {
    cloudEndpoint = new URL(cloudMcpUrl);
    serverEndpoint = new URL(server.url);
  } catch {
    return null;
  }
  if (cloudEndpoint.username || cloudEndpoint.password || serverEndpoint.username || serverEndpoint.password) return null;
  if (serverEndpoint.search || serverEndpoint.hash) return null;
  if (serverEndpoint.origin === cloudEndpoint.origin) return serverEndpoint.toString();

  // Hosted Desktop talks to Den through the app-origin gateway, while Den's
  // authenticated member index names its canonical api-origin proxy. Keep the
  // credential on the configured app origin by translating only this exact,
  // built-in proxy pair and exact per-connection path. Arbitrary cross-origin
  // descriptors still fail closed.
  if (BUILTIN_APP_HOST_GATEWAY_PROXY_ORIGINS.get(cloudEndpoint.origin) !== serverEndpoint.origin) return null;
  const cloudTerminalPath = "/mcp/agent";
  if (!cloudEndpoint.pathname.endsWith(cloudTerminalPath) || cloudEndpoint.search || cloudEndpoint.hash) return null;
  const expectedServerPath = `/mcp/agent/connections/${encodeURIComponent(server.connectionId)}`;
  if (serverEndpoint.pathname !== expectedServerPath) return null;
  const gatewayPrefix = cloudEndpoint.pathname.slice(0, -cloudTerminalPath.length);
  return new URL(`${gatewayPrefix}${serverEndpoint.pathname}`, cloudEndpoint.origin).toString();
}

function isLoopbackHostname(hostname: string): boolean {
  const value = hostname.toLowerCase();
  if (value === "localhost" || value === "::1" || value === "[::1]") return true;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  return Boolean(match && Number(match[1]) === 127 && match.slice(1).every((part) => Number(part) <= 255));
}

async function trustedAppHostCloudEndpoint(cloudMcp: Record<string, unknown>): Promise<boolean> {
  if (typeof cloudMcp.url !== "string") return false;
  let endpoint: URL;
  try {
    endpoint = new URL(cloudMcp.url);
  } catch {
    return false;
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) return false;
  if (BUILTIN_APP_HOST_CLOUD_ORIGINS.has(endpoint.origin)) return true;
  if (process.env.SOFIA_DEV_MODE === "1" && isLoopbackHostname(endpoint.hostname)) return true;
  const activatedEnterpriseOrigin = await readActivatedEnterpriseDenOrigin();
  return activatedEnterpriseOrigin !== null && endpoint.origin === activatedEnterpriseOrigin;
}

/** Stable private App-host identifier. This must never become an Sofia engine MCP key. */
export function connectMcpAppHostName(connectionId: string): string {
  const digest = createHash("sha256").update(connectionId).digest("hex").slice(0, 12);
  return `${CONNECT_MCP_APP_HOST_NAME_PREFIX}${digest}`;
}

export async function readSofiaConnectMcpAppHostCatalog(
  config: ServerConfig,
  workspaceId: string,
): Promise<SofiaConnectMcpServerIndex> {
  return await appHostCatalogStore.get(config, workspaceId) ?? emptyIndex();
}

export async function writeSofiaConnectMcpAppHostCatalog(
  config: ServerConfig,
  workspaceId: string,
  catalog: SofiaConnectMcpServerIndex,
): Promise<void> {
  const parsed = indexSchema.safeParse(catalog);
  await appHostCatalogStore.set(config, workspaceId, parsed.success ? parsed.data : emptyIndex());
}

export async function readSofiaConnectMcpAppHostAuthorization(
  config: ServerConfig,
  workspaceId: string,
  endpointUrl: string,
): Promise<string | null> {
  const credential = await appHostAuthorizationStore.get(config, workspaceId);
  const expectedOrigin = endpointOrigin(endpointUrl);
  if (!credential || !expectedOrigin || credential.origin !== expectedOrigin) return null;
  return privateAppHostAuthorization(credential.authorization);
}

export async function writeSofiaConnectMcpAppHostAuthorization(
  config: ServerConfig,
  workspaceId: string,
  value: string,
  sourceUrl: string,
): Promise<void> {
  const authorization = privateAppHostAuthorization(value);
  const origin = endpointOrigin(sourceUrl);
  await appHostAuthorizationStore.set(
    config,
    workspaceId,
    authorization && origin ? { authorization, origin } : null,
  );
}

export async function findSofiaConnectMcpAppHostServer(
  config: ServerConfig,
  workspaceId: string,
  reference: { connectionId?: string; serverName?: string },
): Promise<SofiaConnectMcpServerIndex["servers"][number] | null> {
  const catalog = await readSofiaConnectMcpAppHostCatalog(config, workspaceId);
  return catalog.servers.find((server) => (
    (reference.connectionId !== undefined && server.connectionId === reference.connectionId)
    || (reference.serverName !== undefined && connectMcpAppHostName(server.connectionId) === reference.serverName)
  )) ?? null;
}

export async function readSofiaConnectMcpServerIndex(
  cloudMcp: Record<string, unknown>,
  appHostAuthorization: string,
  fetcher: McpFetch = externalFetch,
): Promise<SofiaConnectMcpServerIndex | null> {
  if (!await trustedAppHostCloudEndpoint(cloudMcp)) return null;
  const text = await readMcpResourceText({
    config: {
      ...cloudMcp,
      headers: {
        Authorization: appHostAuthorization,
        [CONNECT_MCP_APP_HOST_CAPABILITY_HEADER]: CONNECT_MCP_APP_HOST_CAPABILITY,
      },
    },
    uri: CONNECT_MCP_SERVER_INDEX_URI,
    fetcher,
    clientName: "sofia-server-connect-mcp-catalog",
  });
  if (text === null) return null;
  const parsed = indexSchema.safeParse(JSON.parse(text));
  if (!parsed.success) return null;
  const servers: SofiaConnectMcpServerIndex["servers"] = [];
  for (const server of parsed.data.servers) {
    const url = normalizeAppHostProxyUrl(cloudMcp.url, server);
    if (!url) return null;
    servers.push({ ...server, url });
  }
  return { ...parsed.data, servers };
}

/**
 * Refreshes the private App-host catalog when a gateway launch proves the
 * cached catalog may be stale. Unlike startup reconciliation, an unavailable
 * opportunistic refresh preserves the last known-good catalog.
 */
export async function refreshSofiaConnectMcpAppHostCatalog(
  config: ServerConfig,
  workspaceId: string,
  fetcher?: McpFetch,
): Promise<{ status: "synced" | "unavailable"; appHostNames: string[] }> {
  const cloudMcp = await readRuntimeMcpConfig(config, workspaceId, "sofia-cloud");
  if (!cloudMcp || !await trustedAppHostCloudEndpoint(cloudMcp)) {
    return { status: "unavailable", appHostNames: [] };
  }
  const appHostAuthorization = await readSofiaConnectMcpAppHostAuthorization(
    config,
    workspaceId,
    String(cloudMcp.url),
  );
  if (!appHostAuthorization) return { status: "unavailable", appHostNames: [] };

  const index = await readSofiaConnectMcpServerIndex(cloudMcp, appHostAuthorization, fetcher).catch(() => null);
  if (!index) return { status: "unavailable", appHostNames: [] };

  await writeSofiaConnectMcpAppHostCatalog(config, workspaceId, index);
  return {
    status: "synced",
    appHostNames: index.servers.map((server) => connectMcpAppHostName(server.connectionId)).sort(),
  };
}

/**
 * Keeps provider descriptors private to the Desktop App host and removes any
 * legacy Sofia-owned provider endpoints from the model-facing runtime.
 * User-authored MCP configurations and durable provider records are untouched.
 */
export async function reconcileSofiaConnectMcpServers(input: {
  config: ServerConfig;
  workspace: WorkspaceInfo;
  cloudMcp: Record<string, unknown>;
  appHostAuthorization?: string;
  fetcher?: McpFetch;
}): Promise<{ status: "synced" | "unavailable"; appHostNames: string[]; removedNames: string[] }> {
  const trustedCloudEndpoint = await trustedAppHostCloudEndpoint(input.cloudMcp);
  if (trustedCloudEndpoint && input.appHostAuthorization !== undefined) {
    await writeSofiaConnectMcpAppHostAuthorization(
      input.config,
      input.workspace.id,
      input.appHostAuthorization,
      String(input.cloudMcp.url),
    );
  }
  const appHostAuthorization = trustedCloudEndpoint
    ? await readSofiaConnectMcpAppHostAuthorization(
      input.config,
      input.workspace.id,
      String(input.cloudMcp.url),
    )
    : null;
  const index = trustedCloudEndpoint && appHostAuthorization
    ? await readSofiaConnectMcpServerIndex(input.cloudMcp, appHostAuthorization, input.fetcher).catch(() => null)
    : null;
  const privateCatalog = index ?? emptyIndex();
  await writeSofiaConnectMcpAppHostCatalog(input.config, input.workspace.id, privateCatalog);

  let removedNames: string[] = [];
  await writeRuntimeWorkspaceEngineConfig(input.config, input.workspace.id, (current) => {
    const currentMcp = runtimeMcpMap(current);
    removedNames = Object.keys(currentMcp)
      .filter((name) => name.startsWith(CONNECT_MCP_SERVER_NAME_PREFIX))
      .sort();
    return {
      ...current,
      mcp: Object.fromEntries(Object.entries(currentMcp)
        .filter(([name]) => !name.startsWith(CONNECT_MCP_SERVER_NAME_PREFIX))),
    };
  });
  return {
    status: index ? "synced" : "unavailable",
    appHostNames: privateCatalog.servers.map((server) => connectMcpAppHostName(server.connectionId)).sort(),
    removedNames,
  };
}
