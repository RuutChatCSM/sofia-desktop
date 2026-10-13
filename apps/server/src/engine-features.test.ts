// Tests for the engine feature registry and the config it generates.
import { describe, expect, it } from "bun:test";

import {
  ENGINE_FEATURES,
  engineFeatureCatalog,
  isKnownEngineFeatureKey,
  resolveEngineFeatureEnabled,
  sanitizeEngineFeatureOverrides,
} from "./engine-features.js";
import { applyEngineCapabilitiesToml } from "./codex-config.js";

describe("engine feature registry", () => {
  it("only defaults on features the desktop has a surface for", () => {
    const defaultOn = ENGINE_FEATURES.filter((feature) => feature.defaultEnabled);
    expect(defaultOn.map((feature) => feature.key).sort()).toEqual([
      "multi_agent_v2",
      "request_permissions_tool",
      "update_plan",
    ]);
  });

  it("never defaults on a removed flag", () => {
    for (const feature of ENGINE_FEATURES) {
      if (feature.stage === "removed") expect(feature.defaultEnabled).toBe(false);
    }
  });

  it("marks removed flags as untoggleable but still explains them", () => {
    const catalog = engineFeatureCatalog(null);
    const jsRepl = catalog.find((feature) => feature.key === "js_repl");
    expect(jsRepl?.toggleable).toBe(false);
    expect(jsRepl?.enabled).toBe(false);
    expect(jsRepl?.description.length).toBeGreaterThan(0);
  });

  it("resolves an override over the default", () => {
    expect(resolveEngineFeatureEnabled("update_plan", null)).toBe(true);
    expect(resolveEngineFeatureEnabled("update_plan", { update_plan: false })).toBe(false);
    expect(resolveEngineFeatureEnabled("code_mode", { code_mode: true })).toBe(true);
    // An unknown key falls back to its (absent) default, never to "on".
    expect(resolveEngineFeatureEnabled("unknown_key", { unknown_key: true })).toBe(false);
  });

  it("drops unknown keys and non-boolean values from overrides", () => {
    expect(
      sanitizeEngineFeatureOverrides({ update_plan: false, bogus: true, code_mode: "yes" }),
    ).toEqual({ update_plan: false });
    expect(sanitizeEngineFeatureOverrides(null)).toEqual({});
    expect(sanitizeEngineFeatureOverrides([1, 2])).toEqual({});
  });

  it("exposes a stage for every feature so the UI can label experiments", () => {
    for (const feature of ENGINE_FEATURES) {
      expect(["stable", "under_development", "removed"]).toContain(feature.stage);
      expect(isKnownEngineFeatureKey(feature.key)).toBe(true);
    }
  });
});

describe("applyEngineCapabilitiesToml", () => {
  it("emits the default set when the user has expressed no preference", () => {
    const toml = applyEngineCapabilitiesToml('model_provider = "xiaomi"\n');
    expect(toml).toContain("[features]");
    expect(toml).toContain("multi_agent_v2 = true");
    expect(toml).toContain("request_permissions_tool = true");
    expect(toml).toContain("[tools.update_plan]");
    // Experimental and removed flags stay off unless asked for.
    expect(toml).not.toContain("code_mode = true");
    expect(toml).not.toContain("js_repl");
  });

  it("honours a user override in both directions", () => {
    const off = applyEngineCapabilitiesToml("", { update_plan: false, multi_agent_v2: false });
    expect(off).not.toContain("multi_agent_v2");
    expect(off).not.toContain("[tools.update_plan]");

    const experimentalOn = applyEngineCapabilitiesToml("", { code_mode: true });
    expect(experimentalOn).toContain("code_mode = true");
  });

  it("never emits a removed flag even when an override asks for it", () => {
    const toml = applyEngineCapabilitiesToml("", { js_repl: true });
    expect(toml).not.toContain("js_repl");
  });

  it("is idempotent", () => {
    const once = applyEngineCapabilitiesToml("");
    expect(applyEngineCapabilitiesToml(once)).toBe(once);
    expect(once.match(/multi_agent_v2 = true/g) ?? []).toHaveLength(1);
  });
});
