// The engine feature flags the desktop can turn on or off.
//
// The engine treats every `[features]` key as opt-in: absent means disabled, and
// an unknown key is a hard start failure (`--strict-config`). This module is the
// single registry of which keys the desktop knows about, what stage the engine
// reports for them, and the TOML each one needs — so Settings can offer a toggle
// and the generated config can never drift from the list the UI shows.
//
// Stages mirror the engine's own `FeatureSpec.stage`
// (sofia-rs/features/src/lib.rs). `removed` entries are listed so Settings can
// explain them, but they are never emitted: turning a removed flag on would do
// nothing and would imply a capability that no longer exists.

export type EngineFeatureStage = "stable" | "under_development" | "removed";

export type EngineFeatureKind = "feature" | "tool";

export type EngineFeatureSpec = {
  /** The engine's key, exactly as it appears in `config.toml`. */
  key: string;
  /** Shown in Settings; a sentence, not a title. */
  label: string;
  description: string;
  stage: EngineFeatureStage;
  kind: EngineFeatureKind;
  /**
   * What the desktop enables when the user has expressed no preference. Only
   * features with a desktop surface are ever defaulted on.
   */
  defaultEnabled: boolean;
};

export const ENGINE_FEATURES: readonly EngineFeatureSpec[] = [
  {
    key: "update_plan",
    label: "Task checklist",
    description:
      "Lets the agent track multi-step work as a checklist you can watch in the session.",
    stage: "stable",
    kind: "tool",
    defaultEnabled: true,
  },
  {
    key: "request_permissions_tool",
    label: "Agent asks for extra permissions",
    description:
      "Lets the agent request additional permissions instead of failing the action it was asked to perform.",
    stage: "under_development",
    kind: "feature",
    defaultEnabled: true,
  },
  {
    key: "multi_agent_v2",
    label: "Subagents",
    description:
      "Lets the agent split work across subagents, shown inline as subtasks in the session.",
    stage: "stable",
    kind: "feature",
    defaultEnabled: true,
  },
  {
    key: "code_mode",
    label: "Code mode",
    description:
      "Experimental: runs tool calls as generated JavaScript in a sandboxed host instead of one call at a time. Faster, and less predictable.",
    stage: "under_development",
    kind: "feature",
    defaultEnabled: false,
  },
  {
    key: "deferred_executor",
    label: "Wait for background work",
    description:
      "Experimental: lets the agent park long-running shell work and collect it later. The desktop has no surface for pending waits yet.",
    stage: "under_development",
    kind: "feature",
    defaultEnabled: false,
  },
  {
    key: "js_repl",
    label: "JavaScript REPL (removed)",
    description: "Retired in the engine. Listed only so Settings can say why it is unavailable.",
    stage: "removed",
    kind: "feature",
    defaultEnabled: false,
  },
];

export type EngineFeatureKey = (typeof ENGINE_FEATURES)[number]["key"];

/** A user override for one feature. Absent means "use the default". */
export type EngineFeatureOverrides = Record<string, boolean>;

export function isKnownEngineFeatureKey(key: string): boolean {
  return ENGINE_FEATURES.some((feature) => feature.key === key);
}

export function engineFeatureDefault(key: string): boolean {
  return ENGINE_FEATURES.find((feature) => feature.key === key)?.defaultEnabled ?? false;
}

/** Resolve a feature's effective state, honouring the user's override. */
export function resolveEngineFeatureEnabled(
  key: string,
  overrides: EngineFeatureOverrides | null | undefined,
): boolean {
  // Only a known key can be overridden. A stale or hand-edited entry for a flag
  // this build no longer knows about must resolve to the default, never to "on".
  if (!isKnownEngineFeatureKey(key)) return false;
  const override = overrides?.[key];
  return typeof override === "boolean" ? override : engineFeatureDefault(key);
}

/** Keep only known keys with boolean values, so unknown input is ignored. */
export function sanitizeEngineFeatureOverrides(value: unknown): EngineFeatureOverrides {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const overrides: EngineFeatureOverrides = {};
  for (const [key, enabled] of Object.entries(value as Record<string, unknown>)) {
    if (isKnownEngineFeatureKey(key) && typeof enabled === "boolean") overrides[key] = enabled;
  }
  return overrides;
}

/** The registry as the Settings UI consumes it. */
export function engineFeatureCatalog(overrides: EngineFeatureOverrides | null | undefined) {
  return ENGINE_FEATURES.map((feature) => ({
    key: feature.key,
    label: feature.label,
    description: feature.description,
    stage: feature.stage,
    kind: feature.kind,
    defaultEnabled: feature.defaultEnabled,
    enabled: resolveEngineFeatureEnabled(feature.key, overrides),
    // Removed flags are shown for explanation but can never be switched on.
    toggleable: feature.stage !== "removed",
  }));
}
