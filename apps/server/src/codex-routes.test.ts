// Minimal route-level verification for /codex/* endpoints (additive proof).
import { describe, it, expect, beforeEach } from "bun:test";
import { registerCodexRoutes } from "./codex-routes.js";
import { addRoute } from "./routes/registry.js";

const routes: { method: string; regex: RegExp; keys: string[]; auth: string; handler: Function }[] = [];

function fakeRegistry() {
  return {
    getOrCreate: async () => ({
      engineInfo: { bin: "/fake/codex" },
      listSessions: () => [{ id: "codex-t1", threadId: "t1", title: "x", status: "idle", created: "2025-01-01", turnId: null, workspaceId: "w1" }],
      createSession: async () => ({ id: "codex-t2", threadId: "t2", title: "y", status: "idle", created: "2025-01-01", turnId: null, workspaceId: "w1" }),
      prompt: async () => ({ id: "codex-t2", threadId: "t2", title: "y", status: "running", created: "2025-01-01", turnId: "turn-1", workspaceId: "w1" }),
      abort: async () => {},
      delete: async () => {},
      on: () => () => {},
    }),
  };
}

describe("codex routes", () => {
  beforeEach(() => { routes.length = 0; });
  it("registers 6 routes", () => {
    registerCodexRoutes({
      routes: routes as any,
      config: { host: "127.0.0.1", port: 0, token: "t", workspaces: [] } as any,
      readJsonBody: async (r) => ({}),
      requireClientScope: () => {},
      ensureWritable: () => {},
      registry: fakeRegistry() as any,
    });
    expect(routes.length).toBeGreaterThanOrEqual(6);
  });
});
