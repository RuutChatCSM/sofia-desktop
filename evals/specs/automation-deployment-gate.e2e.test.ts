import { expect } from "vitest"
import { denFetch, evalIn, go } from "@sofia/behaviors"
import { app, needs, server, test } from "@sofia/testkit"

const requirements = {
  optIn: ["SOFIA_EVAL_E2E_TESTS", "SOFIA_EVAL_AUTOMATION_DEPLOYMENT_GATE_E2E_TEST"],
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

test("Desktop availability preserves the legacy Den runtime during rollout", { timeout: 300_000 }, async ({ evidence, place }) => {
  needs(requirements)
  await using den = await server({
    place,
    env: {
      DEN_AUTOMATIONS_ENABLED: "false",
      DEN_AUTOMATIONS_RUNTIME_ENABLED: "true",
    },
  })

  const config = await denFetch(den.admin, "/v1/me/desktop-config", {
    headers: { authorization: `Bearer ${den.admin.token}` },
  })
  expect(config.response.status, config.text).toBe(200)
  expect(isRecord(config.body) ? config.body.automationsEnabled : undefined).toBe(false)

  const list = await denFetch(den.admin, "/v1/automations", {
    headers: { authorization: `Bearer ${den.admin.token}` },
  })
  expect(list.response.status, list.text).toBe(200)
  expect(isRecord(list.body) && Array.isArray(list.body.items)).toBe(true)

  const runnerTokenCallsBeforeDesktop = (await den.apiLog()).split("/v1/automation-runners/token").length - 1
  await using desktop = await app({ den, as: "admin", place })
  await go(desktop, "/automations")
  await expect.poll(
    () => evalIn(desktop, "!/^#\\/automations(?:\\?|$)/.test(location.hash)"),
    { timeout: 60_000 },
  ).toBe(true)

  const logAfterDesktopBoot = await den.apiLog()
  expect(logAfterDesktopBoot.split("/v1/automation-runners/token").length - 1)
    .toBe(runnerTokenCallsBeforeDesktop)
  expect(await den.apiLog()).toContain("Automation scheduler enabled")
  evidence.recordAssertionEvidence(
    "Published Desktop compatibility",
    "Desktop honored unavailable Automations without registering its runner while Den preserved routes and scheduling for published legacy clients until an explicit runtime shutdown.",
    true,
  )
})
