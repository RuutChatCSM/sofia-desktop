import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { inspectMcpLayersFromRuntimeSnapshot } from "./mcp.js";

describe("passive MCP layer inspection", () => {
  test("reports the runtime layer as the only MCP source", async () => {
    const root = await mkdtemp(join(tmpdir(), "sofia-passive-mcp-"));
    try {
      const inspection = await inspectMcpLayersFromRuntimeSnapshot(root, {
        mcp: {
          runtime: { type: "remote", url: "https://runtime.example/mcp" },
        },
      });

      expect(inspection.items).toEqual([
        {
          name: "runtime",
          config: { type: "remote", url: "https://runtime.example/mcp" },
          source: "config.remote",
        },
      ]);
      // Sofia owns the engine config, so there is no static project/global file
      // layer to report and no collisions between layers.
      expect(inspection.layerStatus).toEqual({ project: "missing", global: "missing" });
      expect(inspection.collisions).toEqual([]);
      expect(inspection.toolPolicy).toMatchObject({ status: "unavailable" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("propagates an aborted diagnostics deadline", async () => {
    const root = await mkdtemp(join(tmpdir(), "sofia-passive-mcp-abort-"));
    try {
      const controller = new AbortController();
      controller.abort(new Error("diagnostics deadline exceeded"));

      await expect(inspectMcpLayersFromRuntimeSnapshot(root, {}, {
        signal: controller.signal,
      })).rejects.toThrow("diagnostics deadline exceeded");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
