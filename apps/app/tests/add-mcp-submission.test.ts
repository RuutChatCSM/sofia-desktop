import { describe, expect, test } from "bun:test";

import type { McpDirectoryInfo } from "../src/app/constants";
import { conflictsWithSofiaConnect } from "../src/react-app/domains/connections/mcp-connection-boundary";
import { installIssueMessage, submitMcpEntry } from "../src/react-app/domains/connections/modals/add-mcp-submission";
import { planInstall } from "../src/react-app/domains/connections/install-flow";

const entry: McpDirectoryInfo = {
  name: "BigQuery",
  description: "",
  type: "remote",
  url: "https://bigquery.googleapis.com/mcp",
  oauth: true,
  managedOAuth: true,
};

describe("local MCP submission feedback", () => {
  test("reserves the Sofia Connect runtime name for its managed entry", () => {
    expect(conflictsWithSofiaConnect({ name: "sofia-cloud" })).toBe(true);
    expect(conflictsWithSofiaConnect({ id: "sofia-cloud", name: "Custom cloud" })).toBe(true);
    expect(conflictsWithSofiaConnect({
      name: "Sofia Cloud",
      serverName: "sofia-cloud",
      managedBy: "sofia-connect",
    })).toBe(false);
    expect(conflictsWithSofiaConnect({ name: "BigQuery" })).toBe(false);
  });

  test("returns no error only after the connection succeeds", async () => {
    expect(await submitMcpEntry(async () => ({ ok: true }), entry, "Fallback")).toBeNull();
  });

  test("preserves the server error when the connection fails", async () => {
    expect(await submitMcpEntry(
      async () => ({ ok: false, error: "Secure storage is unavailable." }),
      entry,
      "Fallback",
    )).toBe("Secure storage is unavailable.");
  });

  test("turns a rejected connection into inline feedback", async () => {
    expect(await submitMcpEntry(
      async () => {
        throw new Error("Unexpected server error");
      },
      entry,
      "Fallback",
    )).toBe("Unexpected server error");
  });
});

describe("non-MCP candidates are rejected before the write", () => {
  test("blocks a skill installer and never calls the connect path", async () => {
    let called = false;
    const error = await submitMcpEntry(
      async () => {
        called = true;
        return { ok: true };
      },
      {
        name: "video-maker",
        description: "",
        type: "local",
        command: ["npx", "skills", "add", "remotion-dev/skills"],
        oauth: false,
      },
      "Fallback",
    );

    expect(called).toBe(false);
    expect(error).toBeString();
    expect(error).toContain("remotion-dev/skills");
    expect(error).toContain("skill");
  });

  test("still submits a real local MCP command", async () => {
    const error = await submitMcpEntry(
      async () => ({ ok: true }),
      {
        name: "Filesystem",
        description: "",
        type: "local",
        command: ["npx", "-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
        oauth: false,
      },
      "Fallback",
    );

    expect(error).toBeNull();
  });

  test("explains a command that starts with a flag", () => {
    const message = installIssueMessage(
      planInstall({ name: "Broken", type: "local", command: ["--yes", "server"] }),
    );
    expect(message).toContain("executable");
  });
});

describe("install scope reaches the connect path", () => {
  test("forwards the chosen scope to the connector", async () => {
    const seen: Array<string | undefined> = [];
    const error = await submitMcpEntry(
      async (_entry, scope) => {
        seen.push(scope);
        return { ok: true };
      },
      { name: "Linear", description: "", type: "remote", url: "https://mcp.linear.app/sse", oauth: false },
      "Fallback",
      "global",
    );

    expect(error).toBeNull();
    expect(seen).toEqual(["global"]);
  });

  test("defaults to the project scope", async () => {
    const seen: Array<string | undefined> = [];
    await submitMcpEntry(
      async (_entry, scope) => {
        seen.push(scope);
        return { ok: true };
      },
      { name: "Filesystem", description: "", type: "local", command: ["mcp-server"], oauth: false },
      "Fallback",
    );

    expect(seen).toEqual(["project"]);
  });
});
