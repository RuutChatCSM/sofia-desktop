import { describe, expect, test } from "bun:test";

import { mcpConnectionStatus, parseMcpStatusPage, type NativeMcpServer } from "./codex-mcp-status.js";

function server(overrides: Partial<NativeMcpServer> = {}): NativeMcpServer {
  return { name: "computer-use", runtimeStatus: null, authStatus: "unknown", toolsError: null, tools: [], ...overrides };
}

describe("parseMcpStatusPage", () => {
  test("reads servers, their tools, and the next cursor", () => {
    const page = parseMcpStatusPage({
      data: [{
        name: "computer-use",
        runtimeStatus: "connected",
        authStatus: "unsupported",
        toolsError: null,
        tools: { snapshot: { description: "Capture the screen" }, click: {} },
      }],
      nextCursor: "50",
    });

    expect(page.nextCursor).toBe("50");
    expect(page.data).toEqual([{
      name: "computer-use",
      runtimeStatus: "connected",
      authStatus: "unsupported",
      toolsError: null,
      tools: [{ name: "snapshot", description: "Capture the screen" }, { name: "click" }],
    }]);
  });

  test("reports a threadless inventory as a null runtime status", () => {
    const page = parseMcpStatusPage({ data: [{ name: "sf", authStatus: "notLoggedIn", tools: {} }] });

    expect(page.nextCursor).toBeNull();
    expect(page.data[0]).toEqual({ name: "sf", runtimeStatus: null, authStatus: "notLoggedIn", toolsError: null, tools: [] });
  });

  test("rejects responses that are not a server inventory", () => {
    expect(() => parseMcpStatusPage(null)).toThrow("Invalid Sofia MCP inventory response");
    expect(() => parseMcpStatusPage({ data: "servers" })).toThrow("Invalid Sofia MCP inventory response");
    expect(() => parseMcpStatusPage({ data: [{ name: "no-tools" }] })).toThrow("Invalid Sofia MCP server status");
    expect(() => parseMcpStatusPage({ data: [{ tools: {} }] })).toThrow("Invalid Sofia MCP server status");
  });
});

describe("mcpConnectionStatus", () => {
  test("maps the engine's own failure and auth states", () => {
    expect(mcpConnectionStatus(server({ runtimeStatus: "disabled" }))).toEqual({ status: "disabled" });
    expect(mcpConnectionStatus(server({ runtimeStatus: "authenticationRequired" }))).toEqual({ status: "needs_auth" });
    expect(mcpConnectionStatus(server({ authStatus: "notLoggedIn" }))).toEqual({ status: "needs_auth" });
    expect(mcpConnectionStatus(server({ toolsError: "handshake failed" }))).toEqual({ status: "failed", error: "handshake failed" });
    expect(mcpConnectionStatus(server({ runtimeStatus: "failed" }))).toEqual({ status: "failed", error: "MCP server failed to start" });
  });

  test("does not report a configured server as failed before it has been started", () => {
    // A threadless inventory reports no runtime status, and a server that has
    // not been started yet is configured rather than broken.
    for (const runtimeStatus of [null, "notStarted", "starting", "cancelled"]) {
      expect(mcpConnectionStatus(server({ runtimeStatus }))).toEqual({ status: "connected" });
    }
    expect(mcpConnectionStatus(server({ runtimeStatus: "connected" }))).toEqual({ status: "connected" });
  });
});
