import { z } from "zod"

export const SOFIA_CLOUD_MCP_CONNECTION_ACTION_VERSION = 1 as const
export const SOFIA_CLOUD_MCP_CONNECTION_ACTION_KIND = "connection_action" as const
export const SOFIA_CLOUD_MCP_CONNECTION_ACTION_SOURCE = "sofia-cloud" as const

export const sofiaCloudMcpConnectionActionSchema = z.object({
  version: z.literal(SOFIA_CLOUD_MCP_CONNECTION_ACTION_VERSION),
  kind: z.literal(SOFIA_CLOUD_MCP_CONNECTION_ACTION_KIND),
  source: z.literal(SOFIA_CLOUD_MCP_CONNECTION_ACTION_SOURCE),
  connectionId: z.string().min(1),
  connectionName: z.string().min(1),
  authType: z.enum(["oauth", "apikey", "none"]),
  credentialMode: z.enum(["shared", "per_member"]),
  state: z.enum(["needs_connection", "reauth_required", "provider_error"]),
  actor: z.enum([
    "member",
    "organization_admin",
    "provider_admin",
    "network_admin",
    "sofia",
  ]),
  action: z.object({
    type: z.enum([
      "connect",
      "reconnect",
      "update_credentials",
      "inspect_connection",
      "fix_provider",
      "fix_network",
      "contact_sofia",
    ]),
    surface: z.enum([
      "sofia_your_connections",
      "sofia_organization_connections",
      "provider_admin_console",
      "network_infrastructure",
      "sofia_support",
    ]),
    retry: z.literal("search_capabilities"),
  }),
})

/**
 * The only connection action that chat may execute directly. Shared OAuth,
 * API-key, provider-admin, and support actions remain descriptive because the
 * current member may not own the credential or have permission to repair it.
 */
export const sofiaCloudMcpInlineReconnectSchema = sofiaCloudMcpConnectionActionSchema.extend({
  authType: z.literal("oauth"),
  credentialMode: z.literal("per_member"),
  state: z.literal("reauth_required"),
  actor: z.literal("member"),
  action: z.object({
    type: z.literal("reconnect"),
    surface: z.literal("sofia_your_connections"),
    retry: z.literal("search_capabilities"),
  }),
})

export type SofiaCloudMcpConnectionAction = z.infer<typeof sofiaCloudMcpConnectionActionSchema>
export type SofiaCloudMcpInlineReconnect = z.infer<typeof sofiaCloudMcpInlineReconnectSchema>
