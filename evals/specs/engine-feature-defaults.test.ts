import { expect } from "vitest";
import { test } from "@sofia/testkit";
import { applyEngineCapabilitiesToml } from "../../apps/server/src/codex-config";
import { ENGINE_FEATURES } from "../../apps/server/src/engine-features";

test("startup config enables only stable engine features", () => {
  const defaultOn = ENGINE_FEATURES.filter((feature) => feature.defaultEnabled);
  expect(defaultOn.every((feature) => feature.stage === "stable")).toBe(true);

  const toml = applyEngineCapabilitiesToml('model_provider = "deepseek"\n');
  expect(toml).toContain("multi_agent_v2 = true");
  expect(toml).toContain("[tools.update_plan]");
  expect(toml).not.toContain("request_permissions_tool");
});

test("the experimental permissions tool remains available as an explicit opt-in", () => {
  const toml = applyEngineCapabilitiesToml("", { request_permissions_tool: true });
  expect(toml).toContain("request_permissions_tool = true");
});
