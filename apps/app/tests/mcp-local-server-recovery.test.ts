import { afterEach, describe, expect, test } from "bun:test";

import type { McpDirectoryInfo } from "../src/app/constants";
import { submitMcpEntry } from "../src/react-app/domains/connections/modals/add-mcp-submission";
import type { SofiaServerStore } from "../src/react-app/domains/connections/sofia-server-store";
import { createConnectionsStore } from "../src/react-app/domains/connections/store";

const originalWindow = globalThis.window;

function installDesktopWindow() {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { __SOFIA_ELECTRON__: {} },
  });
}

afterEach(() => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: originalWindow,
  });
});

describe("local MCP server recovery", () => {
  test("returns submission feedback when local server recovery never settles", async () => {
    installDesktopWindow();
    let recoveryAttempts = 0;
    const stalledRecovery = new Promise<never>(() => undefined);
    const sofiaServer = {
      getSnapshot: () => ({
        sofiaServerStatus: "disconnected",
        sofiaServerClient: null,
        sofiaServerCapabilities: null,
      }),
      ensureLocalSofiaServerClient: () => {
        recoveryAttempts += 1;
        return stalledRecovery;
      },
    } as unknown as SofiaServerStore;
    const store = createConnectionsStore({
      client: () => null,
      setClient: () => undefined,
      projectDir: () => "/tmp/sofia-mcp-recovery",
      selectedWorkspaceId: () => "workspace_local",
      selectedWorkspaceRoot: () => "/tmp/sofia-mcp-recovery",
      workspaceType: () => "local",
      sofiaServer,
      runtimeWorkspaceId: () => null,
      ensureRuntimeWorkspaceId: async () => "workspace_local",
      localSofiaServerRecoveryTimeoutMs: 10,
      developerMode: () => false,
    });
    const entry: McpDirectoryInfo = {
      name: "Stalled recovery",
      description: "",
      type: "remote",
      url: "https://example.com/mcp",
      oauth: true,
      managedOAuth: true,
    };

    const result = await Promise.race([
      submitMcpEntry(store.connectMcp, entry, "Fallback error"),
      new Promise<"still pending">((resolve) => setTimeout(() => resolve("still pending"), 250)),
    ]);

    expect(recoveryAttempts).toBe(1);
    expect(result).not.toBe("still pending");
    expect(result).not.toBeNull();
    expect(store.getSnapshot().mcpConnectingName).toBeNull();
  });
});
