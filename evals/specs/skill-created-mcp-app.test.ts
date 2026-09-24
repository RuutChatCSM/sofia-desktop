import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { expect } from "vitest"
import { test } from "@sofia/testkit"

const repoRoot = resolve(import.meta.dirname, "../..")

test("Daytona provisioning builds the skill-created MCP App before Den starts", ({ evidence }) => {
  const script = readFileSync(resolve(repoRoot, ".devcontainer/start-daytona-server.sh"), "utf8")
  const build = "pnpm --filter @sofia-ee/den-api run build:mcp-apps"
  const start = "pnpm --filter @sofia-ee/den-api exec tsx watch src/main.ts"

  expect(script.split(build)).toHaveLength(2)
  expect(script.indexOf(build)).toBeLessThan(script.indexOf(start))
  evidence.recordAssertionEvidence(
    "Fresh Daytona Den startup builds generated MCP App assets",
    "The server bootstrap invokes the Den-owned MCP App build exactly once before launching the Den API process.",
    true,
  )
})

test("create_skill publishes a standard MCP App contract and text fallback", ({ evidence }) => {
  const build = spawnSync("pnpm", ["--filter", "@sofia-ee/den-api", "run", "build:mcp-apps"], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 10 * 1024 * 1024,
  })
  const buildOutput = `${build.stdout}${build.stderr}`
  expect(build.error, buildOutput).toBeUndefined()
  expect(build.status, buildOutput).toBe(0)

  const gateway = spawnSync("pnpm", [
    "--filter",
    "@sofia-ee/den-api",
    "exec",
    "bun",
    "test",
    "test/mcp-skill-created-app.test.ts",
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 10 * 1024 * 1024,
  })
  const gatewayOutput = `${gateway.stdout}${gateway.stderr}`
  expect(gateway.error, gatewayOutput).toBeUndefined()
  expect(gateway.status, gatewayOutput).toBe(0)
  expect(gatewayOutput).toContain("5 pass")
  expect(gatewayOutput).toContain("0 fail")

  evidence.recordAssertionEvidence(
    "create_skill is a standard MCP App tool",
    "The gateway lists one create_skill tool with ui://sofia/skill-created/v1/view.html, model/app visibility, compatibility metadata, and a CSP-closed text/html;profile=mcp-app resource.",
    true,
  )
  evidence.recordAssertionEvidence(
    "Skill creation has structured and non-App results",
    "The same call returns payload-schema-valid structuredContent, stable Plugin and skill identifiers, and a useful text fallback without tomato emoji Markdown.",
    true,
  )
  evidence.recordAssertionEvidence(
    "update_skill shares the skill App",
    "The gateway lists one update_skill tool bound to the same skill-created resource, and updating returns updated-mode structuredContent with a Skill updated text fallback.",
    true,
  )
})
