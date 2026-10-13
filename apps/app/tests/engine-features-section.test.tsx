/** @jsxImportSource react */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { EngineFeatureInfo } from "../src/app/lib/sofia-server";
import { EngineFeaturesSection } from "../src/react-app/domains/settings/pages/advanced-view-sections";

function feature(overrides: Partial<EngineFeatureInfo> & { key: string }): EngineFeatureInfo {
  return {
    label: overrides.key,
    description: `About ${overrides.key}`,
    stage: "stable",
    kind: "feature",
    defaultEnabled: true,
    enabled: true,
    toggleable: true,
    ...overrides,
  };
}

function render(features: EngineFeatureInfo[], extra: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(
    <EngineFeaturesSection
      features={features}
      loading={false}
      busy={false}
      error={null}
      onToggle={() => undefined}
      {...extra}
    />,
  );
}

describe("engine feature flags section", () => {
  test("lists each capability with its description", () => {
    const html = render([
      feature({ key: "update_plan", label: "Task checklist", kind: "tool" }),
      feature({ key: "multi_agent_v2", label: "Subagents" }),
    ]);
    expect(html).toContain("Agent capabilities");
    expect(html).toContain("Task checklist");
    expect(html).toContain("Subagents");
    expect(html).toContain("About multi_agent_v2");
  });

  test("marks experimental capabilities", () => {
    const html = render([feature({ key: "code_mode", label: "Code mode", stage: "under_development" })]);
    expect(html).toContain("Experimental");
    expect(html).toContain("Code mode");
  });

  test("disables the switch for a retired capability", () => {
    const html = render([
      feature({ key: "js_repl", label: "JavaScript REPL", stage: "removed", toggleable: false, enabled: false }),
    ]);
    expect(html).toContain("Unavailable");
    // A retired flag must render off and inert, not merely labelled.
    expect(html).toContain('aria-checked="false"');
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain('disabled=""');
  });

  test("surfaces a load error instead of silently showing defaults", () => {
    const html = render([], { error: "Sofia server unavailable." });
    expect(html).toContain("Sofia server unavailable.");
  });
});
