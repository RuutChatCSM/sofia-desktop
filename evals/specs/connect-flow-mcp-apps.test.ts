import { spawnSync } from "node:child_process"
import { resolve } from "node:path"
import { expect } from "vitest"
import { test } from "@sofia/testkit"

const repoRoot = resolve(import.meta.dirname, "../..")

function runInDenApi(args: string[]): { status: number | null; output: string; error?: Error } {
  const result = spawnSync("pnpm", ["--filter", "@sofia-ee/den-api", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 10 * 1024 * 1024,
  })
  return { status: result.status, output: `${result.stdout}${result.stderr}`, error: result.error }
}

test("connection-action and plugin-flow cards publish standard MCP App contracts", ({ evidence }) => {
  const build = runInDenApi(["run", "build:mcp-apps"])
  expect(build.error, build.output).toBeUndefined()
  expect(build.status, build.output).toBe(0)

  const connection = runInDenApi(["exec", "bun", "test", "test/mcp-connection-action-app.test.ts"])
  expect(connection.error, connection.output).toBeUndefined()
  expect(connection.status, connection.output).toBe(0)
  expect(connection.output).toContain("4 pass")
  expect(connection.output).toContain("0 fail")

  const pluginFlow = runInDenApi(["exec", "bun", "test", "test/mcp-plugin-flow-app.test.ts"])
  expect(pluginFlow.error, pluginFlow.output).toBeUndefined()
  expect(pluginFlow.status, pluginFlow.output).toBe(0)
  expect(pluginFlow.output).toContain("3 pass")
  expect(pluginFlow.output).toContain("0 fail")

  evidence.recordAssertionEvidence(
    "Connection steering is an MCP App",
    "The gateway serves ui://sofia/connection-action/v1/view.html with an app-only connection_action tool, and connection_status payloads map to schema-valid cards carrying the exact human action plus a same-server sofia/mcpApp launch.",
    true,
  )
  evidence.recordAssertionEvidence(
    "Failed tool calls steer to the same card",
    "needs_connection execute failures carry the connection card payload, the same-server launch, and a connectionCard hint telling the model to run the mcp:<connection>:* probe once.",
    true,
  )
  evidence.recordAssertionEvidence(
    "Library sharing flows render confirmation cards",
    "postMarketplacesPlugins, postPluginsAccess, and postMarketplacesAccess successes attach the plugin-flow card with schema-valid structuredContent, while failures and unrelated capabilities stay untouched.",
    true,
  )
})
