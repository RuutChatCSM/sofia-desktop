import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { ExternalMcpConnectionRow } from "../capability-sources/external-mcp-connections.js"

export const CONNECT_MCP_SERVER_INDEX_URI = "sofia://connect/mcp-servers/index.json"
export const CONNECT_MCP_SERVER_INDEX_SCHEMA_VERSION = "sofia.connect/mcp-servers/1"
export const CONNECT_MCP_APP_HOST_CAPABILITY_HEADER = "x-sofia-mcp-client-capabilities"
export const CONNECT_MCP_APP_HOST_CAPABILITY = "mcp-app-host-v1"

export function supportsConnectMcpAppHost(value: string | undefined): boolean {
  return value
    ?.split(",")
    .map((capability) => capability.trim())
    .includes(CONNECT_MCP_APP_HOST_CAPABILITY) ?? false
}

export type ConnectMcpServerIndexEntry = {
  connectionId: string
  name: string
  description: string | null
  url: string
}

export function buildConnectMcpServerIndex(input: {
  enabled: boolean
  connections: ExternalMcpConnectionRow[]
  publicOrigin: string
}) {
  return {
    schemaVersion: CONNECT_MCP_SERVER_INDEX_SCHEMA_VERSION,
    servers: (input.enabled ? input.connections : [])
      .map((connection): ConnectMcpServerIndexEntry => ({
        connectionId: connection.id,
        name: connection.name,
        description: null,
        url: `${input.publicOrigin}/mcp/agent/connections/${encodeURIComponent(connection.id)}`,
      }))
      .sort((left, right) => left.name.localeCompare(right.name) || left.connectionId.localeCompare(right.connectionId)),
  }
}

export function registerConnectMcpServerIndex(input: {
  server: McpServer
  enabled: boolean
  connections: ExternalMcpConnectionRow[]
  publicOrigin: string
}) {
  input.server.registerResource("sofia-connect-mcp-servers", CONNECT_MCP_SERVER_INDEX_URI, {
    title: "Sofia Connect MCP servers",
    description: "Member-authorized MCP servers available through Sofia Connect.",
    mimeType: "application/json",
  }, async () => ({
    contents: [{
      uri: CONNECT_MCP_SERVER_INDEX_URI,
      mimeType: "application/json",
      text: JSON.stringify(buildConnectMcpServerIndex(input)),
    }],
  }))
}
