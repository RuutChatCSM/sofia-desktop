// Guards the engine-feature keys the managed config.toml turns on.
//
// An unknown key in `[features]` is a hard engine start failure, so this
// asserts our list against the engine's own feature table rather than trusting
// the strings here. The engine is a separate repository; when its table cannot be
// located the key assertions are skipped and only the shape is checked, so this
// never fails a checkout that has not cloned the engine.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { applyEngineCapabilitiesToml } from "./codex-config.js";
import {
  ENGINE_FEATURES,
  isKnownEngineFeatureKey,
  sanitizeEngineFeatureOverrides,
} from "./engine-features.js";

const engineFeatures = resolve(import.meta.dir, "../../../sofia/sofia-rs/features/src/lib.rs");

/** What the registry turns on when the user has expressed no preference. */
const DEFAULT_ON_FEATURES = ENGINE_FEATURES.filter((feature) => feature.defaultEnabled && feature.kind === "feature").map((feature) => feature.key);
const DEFAULT_ON_TOOLS = ENGINE_FEATURES.filter((feature) => feature.defaultEnabled && feature.kind === "tool").map((feature) => feature.key);

function engineFeatureKeys(): Set<string> | null {
  if (!existsSync(engineFeatures)) return null;
  const source = readFileSync(engineFeatures, "utf8");
  return new Set([...source.matchAll(/^\s*key:\s*"([a-z0-9_]+)",/gm)].map((match) => match[1] ?? ""));
}

describe("engine capabilities in the managed config.toml", () => {
  test("every enabled feature is a key the engine knows", () => {
    const keys = engineFeatureKeys();
    if (!keys) {
      // Engine not checked out here; nothing to assert against.
      expect(DEFAULT_ON_FEATURES.length).toBeGreaterThan(0);
      return;
    }
    expect(DEFAULT_ON_FEATURES.filter((key) => !keys.has(key))).toEqual([]);
  });

  test("only stages the desktop has a surface for are enabled", () => {
    // UnderDevelopment / Removed features must not ship from the desktop.
    const unsafe = ["code_mode", "js_repl", "deferred_executor"];
    expect(DEFAULT_ON_FEATURES.filter((key) => unsafe.includes(key))).toEqual([]);
  });

  test("merges into an existing [features] table instead of duplicating it", () => {
    const existing = [
      'model_provider = "xiaomi"',
      "",
      "[features.code_mode]",
      'direct_only_tool_namespaces = ["mcp__node_repl"]',
      "",
      "[model_providers.xiaomi]",
      'name = "Xiaomi"',
      "",
    ].join("\n");

    const merged = applyEngineCapabilitiesToml(existing);

    // A second [features] header would make the engine refuse to start.
    expect(merged.match(/^\[features\]$/gm) ?? []).toHaveLength(1);
    // The user's own feature table survives untouched.
    expect(merged).toContain('direct_only_tool_namespaces = ["mcp__node_repl"]');
    expect(merged).toContain("[model_providers.xiaomi]");
    for (const key of DEFAULT_ON_FEATURES) {
      expect(merged).toContain(`${key} = true`);
    }
    for (const key of DEFAULT_ON_TOOLS) {
      expect(merged).toContain(`[tools.${key}]`);
    }
  });

  test("is idempotent, so regeneration does not churn the file", () => {
    const once = applyEngineCapabilitiesToml("");
    expect(applyEngineCapabilitiesToml(once)).toBe(once);
    expect(applyEngineCapabilitiesToml(once).match(/multi_agent_v2 = true/g) ?? []).toHaveLength(1);
  });

  test("turns a disabled flag back on rather than trusting a stale opt-out", () => {
    const disabled = '[features]\nmulti_agent_v2 = false\n';
    expect(applyEngineCapabilitiesToml(disabled)).toContain("multi_agent_v2 = true");
    expect(applyEngineCapabilitiesToml(disabled).match(/multi_agent_v2/g) ?? []).toHaveLength(1);
  });
});
