/** @jsxImportSource react */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { SofiaRuntimeConfigStatus } from "../src/app/lib/sofia-server";
import { AdvancedRuntimeMigrationSection } from "../src/react-app/domains/settings/pages/advanced-view-sections";

const LEGACY_SOFIA_PATH = "/workspace/.sofia/sofia.json";

function runtimeConfigStatus(): SofiaRuntimeConfigStatus {
  return {
    runtime: { mcp: { runtime: { type: "remote", url: "https://runtime.example/mcp" } } },
    runtimeKeys: ["mcp"],
    effectiveRuntime: { default_agent: "sofia", plugin: ["sofia-extensions-preview"] },
    managedFilePath: "/data/runtime-engine-config.json",
    managedFileRebuiltAt: 1_700_000_000_000,
    managedFileContentRedacted: "{ \"default_agent\": \"sofia\" }",
    sweep: null,
    sources: {
      runtimeDatabase: {
        keys: ["mcp"],
        config: { mcp: { runtime: { type: "remote" } } },
      },
      injected: {
        keys: ["default_agent", "plugin"],
        config: { default_agent: "sofia", plugin: ["sofia-extensions-preview"] },
      },
    },
    legacySofia: { path: LEGACY_SOFIA_PATH, keys: ["default_agent"], error: null },
  };
}

function render(configStatus: SofiaRuntimeConfigStatus | null): string {
  return renderToStaticMarkup(
    <AdvancedRuntimeMigrationSection
      busy={false}
      canMigrate
      migrationBusy={false}
      migrationStatus={null}
      configStatus={configStatus}
      configStatusBusy={false}
      configStatusError={null}
      onRefresh={async () => {}}
      onMigrate={async () => {}}
    />,
  );
}

describe("Advanced runtime migration section", () => {
  test("renders the Sofia App-managed config sources and legacy metadata", () => {
    const html = render(runtimeConfigStatus());

    expect(html).toContain("Desired Sofia App runtime config");
    expect(html).toContain("Sofia App runtime DB");
    expect(html).toContain("Sofia App injected config");
    expect(html).toContain("sofia-extensions-preview");
    expect(html).toContain("Legacy Sofia App metadata");
    expect(html).toContain(LEGACY_SOFIA_PATH);
  });

  test("does not render engine-owned config sources the server no longer reports", () => {
    const html = render(runtimeConfigStatus());

    expect(html).not.toContain("Project engine config");
    expect(html).not.toContain("Global engine config");
    expect(html).not.toContain("User engine.jsonc");
  });

  test("renders the desired runtime config without any server sources", () => {
    const status = runtimeConfigStatus();
    const html = render({ ...status, sources: undefined });

    expect(html).toContain("Desired Sofia App runtime config");
    expect(html).not.toContain("Engine source breakdown");
  });
});
