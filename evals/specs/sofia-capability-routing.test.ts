import { test } from "@sofia/testkit";
import { expect } from "vitest";
import { buildSofiaDeveloperInstructions } from "../../apps/server/src/codex-prompt-harness";
import { renderSofiaConnectSkillCatalogInstruction, renderSofiaConnectSkillInstruction, type SofiaConnectSkill } from "../../apps/server/src/connect-skill-catalog";
import {
  SOFIA_CLOUD_CONNECTION_INSTRUCTION,
  SOFIA_EXTENSION_DISCOVERY_INSTRUCTION,
} from "../../apps/server/src/engine-plugins/sofia-extensions-preview-steering";

test("natural requests can discover callable tools and plugins across Sofia runtimes", ({ evidence }) => {
  const codex = buildSofiaDeveloperInstructions({ workspaceId: "ws_test", cwd: "/workspace" });
  for (const instruction of [codex, SOFIA_CLOUD_CONNECTION_INSTRUCTION, SOFIA_EXTENSION_DISCOVERY_INSTRUCTION]) {
    expect(instruction).toMatch(/do not need to name|without requiring a tool/i);
    expect(instruction).toContain("plugin-provided tools");
    expect(instruction).toContain("tool_search");
  }

  const skills: SofiaConnectSkill[] = Array.from({ length: 150 }, (_, index) => ({
    name: `skill-${index}`,
    type: "skill-md",
    description: `Help with workflow ${index}. ${"Specialist instructions. ".repeat(15)}`,
    url: `skill://skill-${index}/SKILL.md`,
    capability: `skill:skill-${index}`,
  }));
  const catalog = renderSofiaConnectSkillInstruction(skills);
  expect(catalog.length).toBeLessThanOrEqual(12_000);
  expect(catalog).toContain("more remote skills are available");
  expect(catalog).toContain("Search sofia-cloud capabilities by task keywords");
  expect(renderSofiaConnectSkillCatalogInstruction({ status: "unavailable", skills: [] })).toContain("Do not infer that no skills exist");
  evidence.recordAssertionEvidence("Capability discovery remains available in both runtimes", "Natural requests can trigger discovery of plugin tools and skills; large Cloud catalogs stay bounded and direct the agent to search beyond the visible list.", true);
});
