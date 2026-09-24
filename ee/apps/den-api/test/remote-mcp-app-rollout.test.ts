import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

const denApiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

function probe(script: string, value?: string) {
  return spawnSync(process.execPath, ["--conditions", "development", "--eval", script], {
    cwd: denApiRoot,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      TMPDIR: process.env.TMPDIR ?? "",
      DATABASE_URL: "mysql://root:password@127.0.0.1:3306/sofia_test",
      DB_MODE: "mysql",
      DEN_DB_ENCRYPTION_KEY: "x".repeat(32),
      BETTER_AUTH_SECRET: "y".repeat(32),
      BETTER_AUTH_URL: "https://den.sofia.test",
      SOFIA_DEV_MODE: "0",
      PROVISIONER_MODE: "stub",
      ...(value === undefined ? {} : { DEN_REMOTE_MCP_APPS_ENABLED: value }),
    },
  })
}

function probeRemoteMcpApps(value?: string) {
  return probe(`
    const { env } = await import("./src/env.ts")
    console.log(JSON.stringify(env.remoteMcpAppsEnabled))
  `, value)
}

function probeNativeMcpAppIndex(
  value: string | undefined,
  organizationEnabled: boolean,
  clientCapabilities?: string,
) {
  return probe(`
    const { env } = await import("./src/env.ts")
    const { remoteMcpAppsEnabled } = await import("./src/capability-sources/remote-mcp-apps-rollout.ts")
    const { buildConnectMcpServerIndex, supportsConnectMcpAppHost } = await import("./src/mcp/connect-mcp-server-index.ts")
    const index = buildConnectMcpServerIndex({
      enabled: remoteMcpAppsEnabled(
        { capabilities: { remoteMcpApps: ${JSON.stringify(organizationEnabled)} } },
        { deploymentEnabled: env.remoteMcpAppsEnabled },
      ) && supportsConnectMcpAppHost(${JSON.stringify(clientCapabilities)}),
      connections: [{ id: "emc_fixture", name: "Fixture MCP" }],
      publicOrigin: "https://sofia.example",
    })
    console.log(JSON.stringify(index.servers.map((server) => server.name)))
  `, value)
}

test("Remote MCP Apps deployment gate defaults off and requires an explicit true", () => {
  const unset = probeRemoteMcpApps()
  const disabled = probeRemoteMcpApps("false")
  const enabled = probeRemoteMcpApps("true")

  expect(unset.status).toBe(0)
  expect(unset.stdout.trim()).toBe("false")
  expect(disabled.status).toBe(0)
  expect(disabled.stdout.trim()).toBe("false")
  expect(enabled.status).toBe(0)
  expect(enabled.stdout.trim()).toBe("true")
})

test("native provider publication requires both rollout gates and explicit client support", () => {
  const absentDeployment = probeNativeMcpAppIndex(undefined, true, "mcp-app-host-v1")
  const disabledDeployment = probeNativeMcpAppIndex("false", true, "mcp-app-host-v1")
  const disabledOrganization = probeNativeMcpAppIndex("true", false, "mcp-app-host-v1")
  const legacyClient = probeNativeMcpAppIndex("true", true)
  const enabled = probeNativeMcpAppIndex("true", true, "future-v2, mcp-app-host-v1")

  expect(absentDeployment.status).toBe(0)
  expect(absentDeployment.stdout.trim()).toBe("[]")
  expect(disabledDeployment.status).toBe(0)
  expect(disabledDeployment.stdout.trim()).toBe("[]")
  expect(disabledOrganization.status).toBe(0)
  expect(disabledOrganization.stdout.trim()).toBe("[]")
  expect(legacyClient.status).toBe(0)
  expect(legacyClient.stdout.trim()).toBe("[]")
  expect(enabled.status).toBe(0)
  expect(enabled.stdout.trim()).toBe('["Fixture MCP"]')
})
