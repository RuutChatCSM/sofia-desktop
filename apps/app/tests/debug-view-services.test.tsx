/** @jsxImportSource react */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { DebugView, type DebugViewProps } from "../src/react-app/domains/settings/pages/debug-view";

const noop = async () => {};

function debugViewProps(): DebugViewProps {
  return {
    developerMode: true,
    agentContextDiagnostics: {
      scopeKey: {},
      available: false,
      unavailableReason: null,
      onRun: async () => {
        throw new Error("diagnostics are not exercised by this render");
      },
    },
    agentAccess: null,
    busy: false,
    anyActiveRuns: false,
    startupPreference: "local",
    startupLabel: "Local",
    startupStatus: null,
    runtimeSummary: {
      appVersionLabel: "1.2.3",
      appCommitLabel: "abcdef0",
      engineVersionLabel: "—",
      sofiaServerVersionLabel: "0.0.0-dev",
    },
    runtimeDebugReportJson: "{}",
    bootstrapConfigDebugJson: "{}",
    runtimeConfigStatus: null,
    runtimeConfigStatusError: null,
    runtimeDebugStatus: null,
    onCopyRuntimeDebugReport: noop,
    onExportRuntimeDebugReport: noop,
    developerLogRecordCount: 0,
    developerLogText: "",
    developerLogStatus: null,
    onClearDeveloperLog: noop,
    onCopyDeveloperLog: noop,
    onExportDeveloperLog: noop,
    electronMigrationAvailable: false,
    electronMigrationUrl: "",
    electronMigrationSha256: "",
    electronMigrationSha512: "",
    electronMigrationArtifactLabel: null,
    electronMigrationBusy: false,
    electronMigrationStatus: null,
    electronPreviewReleaseUrl: "",
    onSetElectronMigrationUrl: () => {},
    onSetElectronMigrationSha256: () => {},
    onSetElectronMigrationSha512: () => {},
    onOpenElectronPreviewRelease: noop,
    onResolveElectronAlphaArtifact: noop,
    onRevealElectronMigrationBackup: noop,
    onPrepareElectronMigrationSnapshot: noop,
    onInstallElectronPreviewFromTauri: noop,
    electronAlphaUpdaterAvailable: false,
    electronAlphaUpdaterBusy: false,
    electronAlphaUpdaterStatus: null,
    electronAlphaUpdaterChannel: "stable",
    onSetElectronAlphaUpdaterChannel: () => {},
    onCheckElectronAlphaUpdates: noop,
    onStopHost: noop,
    onResetStartupPreference: noop,
    onOpenResetModal: () => {},
    resetModalBusy: false,
    resetStatus: null,
    sofiaServerRestarting: false,
    sofiaServiceStatus: null,
    sofiaLogStatus: null,
    onCopySofiaLogs: noop,
    onExportSofiaLogs: noop,
    serviceRestartError: null,
    onRestartSofiaServer: noop,
    onInstallCodexEngine: noop,
    codexInstallBusy: false,
    codexInstallStatus: null,
    codexEngineCard: {
      label: "Available",
      className: "border-green-7/40 bg-green-4/50 text-green-11",
      lines: ["Status: Available", "Binary: /opt/sofia/sidecars/sofia (sidecar)"],
      error: null,
    },
    engineConnectCard: {
      label: "Disconnected",
      className: "border-gray-7/30 bg-gray-4/50 text-gray-11",
      lines: ["Base URL: —"],
      metricsLines: [],
      error: null,
    },
    sofiaCard: {
      label: "Connected",
      className: "border-green-7/40 bg-green-4/50 text-green-11",
      lines: ["Base URL: http://127.0.0.1:59827"],
      stdout: null,
      stderr: null,
      execution: null,
      error: null,
    },
    sofiaServerDiagnostics: null,
    runtimeWorkspaceId: "ws_1",
    sofiaServerCapabilities: null,
    pendingPermissions: {},
    events: [],
    workspaceDebugEvents: [],
    workspaceDebugEventsStatus: null,
    safeStringify: (value: unknown) => JSON.stringify(value),
    onClearWorkspaceDebugEvents: noop,
    sofiaAuditEntries: [],
    sofiaAuditStatus: { label: "Idle", className: "border-gray-7/30 bg-gray-4/50 text-gray-11" },
    sofiaAuditError: null,
    engineConnectStatus: null,
    engineDevModeEnabled: false,
    nukeConfigBusy: false,
    nukeConfigStatus: null,
    nukePreviewBusy: false,
    nukeDialogOpen: false,
    nukeConfirmationText: "",
    nukeDeleteBootstrap: false,
    nukeManifestPreview: null,
    onOpenNukeDialog: noop,
    onCloseNukeDialog: () => {},
    onSetNukeConfirmationText: () => {},
    onSetNukeDeleteBootstrap: noop,
    onConfirmNukeSofiaAndWorkspaceEngineConfig: noop,
  };
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("Debug services section", () => {
  test("shows one Sofia engine service card instead of the duplicated legacy engine card", () => {
    const html = renderToStaticMarkup(<DebugView {...debugViewProps()} />);

    expect(countOccurrences(html, ">Sofia engine</div>")).toBe(1);
    expect(html).toContain("Multi-model Sofia engine managed by Sofia App.");
    expect(html).not.toContain("Local engine process managed by Sofia App.");
  });

  test("drops the removed engine runtime selection", () => {
    const html = renderToStaticMarkup(<DebugView {...debugViewProps()} />);

    expect(html).not.toContain("Choose how the engine runs locally.");
    expect(html).not.toContain("Bundled (recommended)");
    expect(html).not.toContain("System install (PATH)");
    expect(html).not.toContain("Custom binary");
  });
});
