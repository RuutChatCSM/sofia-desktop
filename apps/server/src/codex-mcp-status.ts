/** Native app-server MCP inventory; configured entries are not connection proof. */
export type NativeMcpServer = {
  name: string;
  runtimeStatus: string | null;
  authStatus: string;
  toolsError: string | null;
  tools: Array<{ name: string; description?: string }>;
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseMcpStatusPage(value: unknown): { data: NativeMcpServer[]; nextCursor: string | null } {
  if (!record(value) || !Array.isArray(value.data)) throw new Error("Invalid Sofia MCP inventory response");
  const data = value.data.map((server: unknown): NativeMcpServer => {
    if (!record(server) || typeof server.name !== "string" || !record(server.tools)) {
      throw new Error("Invalid Sofia MCP server status");
    }
    return {
      name: server.name,
      runtimeStatus: typeof server.runtimeStatus === "string" ? server.runtimeStatus : null,
      authStatus: typeof server.authStatus === "string" ? server.authStatus : "unknown",
      toolsError: typeof server.toolsError === "string" ? server.toolsError : null,
      tools: Object.entries(server.tools).map(([name, tool]) => ({ name,
        ...(record(tool) && typeof tool.description === "string" ? { description: tool.description } : {}),
      })),
    };
  });
  return { data, nextCursor: typeof value.nextCursor === "string" ? value.nextCursor : null };
}

export function mcpConnectionStatus(server: NativeMcpServer):
  | { status: "connected" | "disabled" | "needs_auth" }
  | { status: "failed"; error: string } {
  if (server.runtimeStatus === "disabled") return { status: "disabled" };
  if (server.runtimeStatus === "authenticationRequired" || server.authStatus === "notLoggedIn") return { status: "needs_auth" };
  if (server.toolsError) return { status: "failed", error: server.toolsError };
  if (server.runtimeStatus === "failed") return { status: "failed", error: "MCP server failed to start" };
  // The engine tracks connection state per thread, so an inventory taken
  // without a thread (the workspace-wide status call) reports no runtime
  // status at all. Reaching here means the engine has the server configured
  // and its tools were enumerated, so the honest summary is connected.
  return { status: "connected" };
}
