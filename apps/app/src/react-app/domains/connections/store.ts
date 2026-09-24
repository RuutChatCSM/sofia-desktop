import { useSyncExternalStore } from "react";

import { applyEdits, modify, parse, printParseErrorCode } from "jsonc-parser";

import { t } from "../../../i18n";
import {
  getMcpServerName,
  MCP_QUICK_CONNECT,
  type McpDirectoryInfo,
} from "../../../app/constants";
import { extensionResource } from "../../../app/extensions";
import {
  mintCloudControlMcpToken,
  readDenSettings,
} from "../../../app/lib/den";
import { createClient, unwrap } from "../../../app/lib/engine";
import { finishPerf, perfNow, recordPerfLog } from "../../../app/lib/perf-log";
import {
  assertDesktopWebUrl,
  openDesktopUrl,
} from "../../../app/lib/desktop";
import { toSessionTransportDirectory } from "../../../app/lib/session-scope";
import {
  parseMcpServersFromContent,
  validateMcpServerName,
} from "../../../app/mcp";
import {
  buildSofiaWorkspaceBaseUrl,
  type SofiaServerClient,
} from "../../../app/lib/sofia-server";
import type {
  Client,
  McpServerEntry,
  McpStatusMap,
  ReloadReason,
  ReloadTrigger,
} from "../../../app/types";
import { isDesktopRuntime, normalizeDirectoryPath, safeStringify } from "../../../app/utils";
import { conflictsWithSofiaConnect } from "./mcp-connection-boundary";

import type { SofiaServerStore } from "./sofia-server-store";
import { attemptSilentMcpReauth } from "./mcp-silent-reauth";
import {
  CLOUD_MCP_SERVER_NAME,
  readCloudMcpUserState,
} from "./cloud-mcp-user-state";
import {
  clearCloudMcpDisabledIntent,
  cloudMcpDisplaySummary,
  recordCloudMcpDisabledIntent,
  runSofiaCloudMcpReconciler,
  type CloudMcpOperationContext,
} from "./cloud-mcp-reconciler";

type SetStateAction<T> = T | ((current: T) => T);

// Re-mint when less than a day of token validity remains. Must be well
// below the minted token TTL (7 days, DEN_FIRST_PARTY_MCP_TOKEN_TTL_MS in
// den-api): when the two were equal, the marker was stale the instant it
// was written and every sync tick re-wrote the MCP config.
const CLOUD_MCP_REFRESH_MARGIN_MS = 24 * 60 * 60 * 1000;
const LOCAL_SOFIA_SERVER_RECOVERY_TIMEOUT_MS = 30_000;

async function withLocalSofiaServerRecoveryTimeout<T>(
  task: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(t("mcp.connect_failed"))), timeoutMs);
  });
  try {
    return await Promise.race([task, timeout]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

export type ConnectionsStoreSnapshot = {
  mcpServers: McpServerEntry[];
  mcpStatus: string | null;
  mcpLastUpdatedAt: number | null;
  mcpStatuses: McpStatusMap;
  mcpConnectingName: string | null;
  selectedMcp: string | null;
  mcpAuthModalOpen: boolean;
  mcpAuthEntry: McpDirectoryInfo | null;
  mcpAuthNeedsReload: boolean;
  /** False when the server reports managed OAuth secure storage is unavailable. */
  managedOAuthAvailable: boolean;
};

type MutableState = ConnectionsStoreSnapshot;

export type ConnectionsStore = ReturnType<typeof createConnectionsStore>;

export type McpConnectResult =
  | { ok: true }
  | { ok: false; error: string };

export function createConnectionsStore(options: {
  client: () => Client | null;
  setClient: (value: Client | null) => void;
  projectDir: () => string;
  selectedWorkspaceId: () => string;
  selectedWorkspaceRoot: () => string;
  workspaceType: () => "local" | "remote";
  sofiaServer: SofiaServerStore;
  runtimeWorkspaceId: () => string | null;
  ensureRuntimeWorkspaceId?: () => Promise<string | null | undefined>;
  localSofiaServerRecoveryTimeoutMs?: number;
  setProjectDir?: (value: string) => void;
  developerMode: () => boolean;
  markReloadRequired?: (reason: ReloadReason, trigger?: ReloadTrigger) => void;
}) {
  const listeners = new Set<() => void>();

  let started = false;
  let disposed = false;
  let lastWorkspaceContextKey = "";
  let lastProjectDir = "";
  let snapshot: ConnectionsStoreSnapshot;

  let state: MutableState = {
    mcpServers: [],
    mcpStatus: null,
    mcpLastUpdatedAt: null,
    mcpStatuses: {},
    mcpConnectingName: null,
    selectedMcp: null,
    mcpAuthModalOpen: false,
    mcpAuthEntry: null,
    mcpAuthNeedsReload: false,
    managedOAuthAvailable: true,
  };

  const emitChange = () => {
    for (const listener of listeners) listener();
  };

  const refreshSnapshot = () => {
    snapshot = {
      mcpServers: state.mcpServers,
      mcpStatus: state.mcpStatus,
      mcpLastUpdatedAt: state.mcpLastUpdatedAt,
      mcpStatuses: state.mcpStatuses,
      mcpConnectingName: state.mcpConnectingName,
      selectedMcp: state.selectedMcp,
      mcpAuthModalOpen: state.mcpAuthModalOpen,
      mcpAuthEntry: state.mcpAuthEntry,
      mcpAuthNeedsReload: state.mcpAuthNeedsReload,
      managedOAuthAvailable: state.managedOAuthAvailable,
    };
  };

  const mutateState = (updater: (current: MutableState) => MutableState) => {
    state = updater(state);
    refreshSnapshot();
    emitChange();
  };

  const setStateField = <K extends keyof MutableState>(key: K, value: MutableState[K]) => {
    if (Object.is(state[key], value)) return;
    mutateState((current) => ({ ...current, [key]: value }));
  };

  const applyStateAction = <T,>(current: T, next: SetStateAction<T>) =>
    typeof next === "function" ? (next as (value: T) => T)(current) : next;

  const getWorkspaceContextKey = () => {
    const workspaceId = options.selectedWorkspaceId().trim();
    const root = normalizeDirectoryPath(options.selectedWorkspaceRoot().trim());
    const runtimeWorkspaceId = (options.runtimeWorkspaceId() ?? "").trim();
    const workspaceType = options.workspaceType();
    return `${workspaceType}:${workspaceId}:${root}:${runtimeWorkspaceId}`;
  };

  const getSofiaSnapshot = () => options.sofiaServer.getSnapshot();

  const resolveSofiaWorkspaceId = async () => {
    const current = options.runtimeWorkspaceId()?.trim();
    if (current) return current;
    const sofiaSnapshot = getSofiaSnapshot();
    if (sofiaSnapshot.sofiaServerStatus !== "connected" || !sofiaSnapshot.sofiaServerClient) {
      return null;
    }
    const ensured = (await options.ensureRuntimeWorkspaceId?.())?.trim();
    if (ensured) return ensured;
    return options.workspaceType() === "local" ? options.selectedWorkspaceId().trim() || null : null;
  };

  const resolveConfigSofiaTarget = async (mode: "read" | "write") => {
    const sofiaSnapshot = getSofiaSnapshot();
    const sofiaClient = sofiaSnapshot.sofiaServerClient;
    const sofiaWorkspaceId = await resolveSofiaWorkspaceId();
    const hasSofiaTarget =
      sofiaSnapshot.sofiaServerStatus === "connected" &&
      Boolean(sofiaClient && sofiaWorkspaceId);
    const canUseSofiaServer =
      hasSofiaTarget &&
      sofiaSnapshot.sofiaServerCapabilities?.config?.[mode] !== false;
    return {
      sofiaClient,
      sofiaWorkspaceId,
      hasSofiaTarget,
      canUseSofiaServer,
    };
  };

  const resolveMcpSofiaTarget = async (mode: "read" | "write") => {
    let sofiaSnapshot = getSofiaSnapshot();
    let sofiaClient = sofiaSnapshot.sofiaServerClient;
    let sofiaWorkspaceId = await resolveSofiaWorkspaceId();
    if ((!sofiaClient || !sofiaWorkspaceId || sofiaSnapshot.sofiaServerStatus !== "connected")
      && isDesktopRuntime()
      && options.workspaceType() === "local") {
      sofiaClient = await withLocalSofiaServerRecoveryTimeout(
        options.sofiaServer.ensureLocalSofiaServerClient(),
        options.localSofiaServerRecoveryTimeoutMs ?? LOCAL_SOFIA_SERVER_RECOVERY_TIMEOUT_MS,
      );
      sofiaSnapshot = getSofiaSnapshot();
      sofiaWorkspaceId = options.runtimeWorkspaceId()?.trim()
        || (await options.ensureRuntimeWorkspaceId?.())?.trim()
        || options.selectedWorkspaceId().trim()
        || null;
    }
    const hasSofiaTarget =
      Boolean(sofiaClient && sofiaWorkspaceId);
    const canUseSofiaServer =
      hasSofiaTarget &&
      sofiaSnapshot.sofiaServerCapabilities?.mcp?.[mode] !== false;
    return {
      sofiaClient,
      sofiaWorkspaceId,
      hasSofiaTarget,
      canUseSofiaServer,
    };
  };

  const filterConfiguredStatuses = (status: McpStatusMap, entries: McpServerEntry[]) => {
    const configured = new Set(entries.map((entry) => entry.name));
    return Object.fromEntries(
      Object.entries(status).filter(([name]) => configured.has(name)),
    ) as McpStatusMap;
  };

  const ensureActiveClient = async () => {
    let activeClient = options.client();
    if (activeClient) {
      return activeClient;
    }

    const sofiaSnapshot = getSofiaSnapshot();
    const sofiaBaseUrl = sofiaSnapshot.sofiaServerBaseUrl.trim();
    const token = sofiaSnapshot.sofiaServerAuth.token?.trim();
    if (!sofiaBaseUrl || !token) {
      return null;
    }

    const mountedBaseUrl =
      buildSofiaWorkspaceBaseUrl(sofiaBaseUrl, await resolveSofiaWorkspaceId()) ?? sofiaBaseUrl;
    activeClient = createClient(`${mountedBaseUrl.replace(/\/+$/, "")}/engine`, undefined, {
      token,
      mode: "sofia",
    });
    options.setClient(activeClient);
    return activeClient;
  };

  const resolveWritableSofiaTarget = async () => {
    return resolveMcpSofiaTarget("write");
  };

  const resolveCloudMcpOperationContext = async (fallbackUrl?: string | null): Promise<CloudMcpOperationContext | null> => {
    const settings = readDenSettings();
    const workspaceId = await resolveSofiaWorkspaceId();
    const serverBaseUrl = getSofiaSnapshot().sofiaServerClient?.baseUrl.trim() ?? "";
    const orgId = settings.activeOrgId?.trim() ?? "";
    if (!workspaceId || !serverBaseUrl || !orgId) return null;
    return {
      denBaseUrl: settings.baseUrl,
      serverBaseUrl,
      workspaceId,
      orgId,
      denAuthToken: settings.authToken ?? null,
      orgSlug: settings.activeOrgSlug,
      orgName: settings.activeOrgName,
      fallbackUrl,
    };
  };

  const resolveProjectDir = async (activeClient: Client | null, currentProjectDir: string) => {
    let resolvedProjectDir = currentProjectDir;
    if (!resolvedProjectDir && activeClient) {
      try {
        const pathInfo = unwrap(await activeClient.path.get());
        const discoveredRaw = toSessionTransportDirectory(pathInfo.directory ?? "");
        const discovered = discoveredRaw.replace(/^\/private\/tmp(?=\/|$)/, "/tmp");
        if (discovered) {
          resolvedProjectDir = discovered;
          options.setProjectDir?.(discovered);
        }
      } catch {
        // ignore
      }
    }

    return resolvedProjectDir;
  };

  const listMcpFromSofiaServer = async (projectDir: string) => {
    const sofiaSnapshot = getSofiaSnapshot();
    const { sofiaClient, sofiaWorkspaceId, hasSofiaTarget, canUseSofiaServer } =
      await resolveMcpSofiaTarget("read");
    const canTrySofiaServer = canUseSofiaServer;

    recordPerfLog(options.developerMode(), "mcp.refresh", "server-path-check", {
      workspaceType: options.workspaceType(),
      projectDir: projectDir || null,
      sofiaStatus: sofiaSnapshot.sofiaServerStatus,
      hasSofiaClient: Boolean(sofiaClient),
      sofiaWorkspaceId: sofiaWorkspaceId ?? null,
      canReadMcp: sofiaSnapshot.sofiaServerCapabilities?.mcp?.read ?? null,
      canTrySofiaServer,
    });

    if (hasSofiaTarget && !canTrySofiaServer) {
      throw new Error("Sofia App server cannot read MCP config for this workspace.");
    }

    if (!canTrySofiaServer || !sofiaClient || !sofiaWorkspaceId) return null;

    const response = await sofiaClient.listMcp(sofiaWorkspaceId);
    const next = response.items.map((entry) => ({
      name: entry.name,
      config: entry.config as McpServerEntry["config"],
      source: entry.source,
      managedOAuth: entry.managedOAuth,
    }));
    const engineSync = response.engineSync ?? null;

    let nextStatuses: McpStatusMap = {};
    const activeClient = options.client();
    if (activeClient && projectDir) {
      try {
        const status = unwrap(await activeClient.mcp.status({ directory: projectDir }));
        nextStatuses = filterConfiguredStatuses(status as McpStatusMap, next);
      } catch {
        nextStatuses = {};
      }
    }

    for (const entry of next) {
      const managed = entry.managedOAuth;
      if (!managed) continue;
      if (!managed.enabled) {
        nextStatuses[entry.name] = { status: "disabled" };
      } else if (managed.status === "reconnect_required") {
        nextStatuses[entry.name] = { status: "reconnect_required" };
      } else if (managed.status === "needs_auth" || managed.status === "connecting") {
        nextStatuses[entry.name] = { status: "needs_auth" };
      } else if (!nextStatuses[entry.name]) {
        nextStatuses[entry.name] = { status: "connected" };
      }
    }

    recordPerfLog(options.developerMode(), "mcp.refresh", "server-path-result", {
      count: next.length,
      names: next.map((entry) => entry.name),
      sources: next.map((entry) => entry.source ?? "unknown"),
      engineSyncStatus: engineSync?.status ?? null,
    });

    return {
      next,
      nextStatuses,
      engineSync,
      managedOAuthAvailable: response.managedOAuthState?.available ?? true,
    };
  };

  const resolveDesktopCommand = async (commandName: "getComputerUseMcpCommand" | "getSofiaUiMcpCommand", fallbackOnError = true) => {
    try {
      const command = await window.__SOFIA_ELECTRON__?.invokeDesktop?.(commandName);
      if (Array.isArray(command) && command.every((part) => typeof part === "string") && command.length > 0) {
        return command;
      }
    } catch (error) {
      if (!fallbackOnError) {
        throw error instanceof Error
          ? error
          : new Error("Computer Use helper app is unavailable. Restart Sofia App or reinstall the app.");
      }
      // Fall through to the published package command in the manifest/catalog.
    }
    return null;
  };

  const resolveLocalMcpCommand = async (entry: McpDirectoryInfo) => {
    const mcpResource = extensionResource(entry.extensionManifest, "mcp");
    if (mcpResource?.localCommandRef === "sofia.computerUseMcp") {
      const command = await resolveDesktopCommand("getComputerUseMcpCommand", false);
      return command ?? entry.command;
    }
    if (mcpResource?.localCommandRef === "sofia.uiMcp" || entry.serverName === "sofia-ui") {
      const command = await resolveDesktopCommand("getSofiaUiMcpCommand");
      return command ?? entry.command;
    }
    return entry.command;
  };

  const resolveLocalMcpEnvironment = async (entry: McpDirectoryInfo) => {
    if (entry.serverName !== "sofia-ui") return undefined;
    try {
      const environment = await window.__SOFIA_ELECTRON__?.invokeDesktop?.("getSofiaUiMcpEnvironment");
      if (environment && typeof environment === "object" && !Array.isArray(environment)) {
        return Object.fromEntries(
          Object.entries(environment).filter((entry): entry is [string, string] =>
            typeof entry[0] === "string" && typeof entry[1] === "string"
          ),
        );
      }
    } catch {
      // Discovery fallback in sofia-ui-mcp still handles normal launches.
    }
    return undefined;
  };

  /**
   * Quiet self-heal for remote OAuth MCPs stuck in "Sign in needed": the
   * engine only refreshes tokens reactively (once per transport), so an
   * expired access token strands the entry until the user clicks Sign in.
   * `mcp.connect` retries the stored refresh-token grant on a fresh
   * transport — silently, never opening a browser or modal. Mirrors
   * syncCloudControlMcp, but for user-added connectors.
   */
  async function healUnhealthyMcpEntries(servers: McpServerEntry[], statuses: McpStatusMap) {
    if (disposed || snapshot.mcpAuthModalOpen || snapshot.mcpConnectingName) return;
    const activeClient = options.client();
    const projectDir = options.projectDir().trim();
    if (!activeClient || !projectDir) return;
    const attempted = await attemptSilentMcpReauth({
      client: activeClient,
      directory: projectDir,
      servers,
      statuses,
    }).catch(() => false);
    if (!attempted || disposed) return;
    try {
      const status = unwrap(await activeClient.mcp.status({ directory: projectDir }));
      setStateField(
        "mcpStatuses",
        filterConfiguredStatuses(status as McpStatusMap, snapshot.mcpServers),
      );
    } catch {
      // Post-heal status refresh is best-effort; the next refresh picks it up.
    }
  }

  async function refreshMcpServers() {
    if (disposed) return;

    const projectDir = options.projectDir().trim();
    const isRemoteWorkspace = options.workspaceType() === "remote";

    try {
      setStateField("mcpStatus", null);
      const serverResult = await listMcpFromSofiaServer(projectDir);
      if (serverResult) {
        // Surface engine registration failures instead of leaving users
        // staring at an MCP that silently shows as disconnected.
        const failedNames = serverResult.engineSync?.status === "failed"
          ? serverResult.engineSync.failures.map((failure) => failure.name).join(", ")
          : "";
        mutateState((current) => ({
          ...current,
          mcpServers: serverResult.next,
          mcpLastUpdatedAt: Date.now(),
          mcpStatuses: serverResult.nextStatuses,
          managedOAuthAvailable: serverResult.managedOAuthAvailable,
          mcpStatus: failedNames
            ? `Some MCPs could not be registered with the engine: ${failedNames}. They may appear disconnected — try reloading the engine.`
            : serverResult.next.length ? null : "No MCP servers configured yet.",
        }));
        void healUnhealthyMcpEntries(serverResult.next, serverResult.nextStatuses);
        return;
      }
    } catch (error) {
      recordPerfLog(options.developerMode(), "mcp.refresh", "server-path-error", {
        message: error instanceof Error ? error.message : String(error),
      });
      const serverTarget = await resolveMcpSofiaTarget("read").catch(() => null);
      if (isRemoteWorkspace || serverTarget?.hasSofiaTarget) {
        mutateState((current) => ({
          ...current,
          mcpServers: [],
          mcpStatuses: {},
          mcpStatus: error instanceof Error ? error.message : "Failed to load MCP servers",
        }));
        return;
      }
    }

    if (isRemoteWorkspace) {
      mutateState((current) => ({
        ...current,
        mcpStatus: "Sofia App server unavailable. MCP config is read-only.",
        mcpServers: [],
        mcpStatuses: {},
      }));
      return;
    }

    if (!isDesktopRuntime()) {
      mutateState((current) => ({
        ...current,
        mcpStatus: "MCP configuration is only available for local workspaces.",
        mcpServers: [],
        mcpStatuses: {},
      }));
      return;
    }

    // Sofia serves MCP config from the runtime DB: there is no local engine
    // config file to read.
    mutateState((current) => ({
      ...current,
      mcpServers: [],
      mcpStatuses: {},
      mcpStatus: "Sofia App server unavailable. Connect to manage MCP servers.",
    }));
  }

  async function connectMcp(entry: McpDirectoryInfo): Promise<McpConnectResult> {
    const startedAt = perfNow();
    const sofiaSnapshot = getSofiaSnapshot();
    const isRemoteWorkspace =
      options.workspaceType() === "remote" ||
      (!isDesktopRuntime() && sofiaSnapshot.sofiaServerStatus === "connected");
    const projectDir = options.projectDir().trim();
    const entryType = entry.type ?? "remote";

    recordPerfLog(options.developerMode(), "mcp.connect", "start", {
      name: entry.name,
      type: entryType,
      workspaceType: isRemoteWorkspace ? "remote" : "local",
      projectDir: projectDir || null,
    });

    const { sofiaClient, sofiaWorkspaceId, hasSofiaTarget, canUseSofiaServer } =
      await resolveWritableSofiaTarget();

    if (isRemoteWorkspace && !canUseSofiaServer) {
      const error = "Sofia App server unavailable. MCP config is read-only.";
      setStateField("mcpStatus", error);
      finishPerf(options.developerMode(), "mcp.connect", "blocked", startedAt, {
        reason: "sofia-server-unavailable",
      });
      return { ok: false, error };
    }

    if (hasSofiaTarget && !canUseSofiaServer) {
      const error = "Sofia App server MCP config is read-only.";
      setStateField("mcpStatus", error);
      finishPerf(options.developerMode(), "mcp.connect", "blocked", startedAt, {
        reason: "sofia-server-read-only",
      });
      return { ok: false, error };
    }

    if (!canUseSofiaServer && !isDesktopRuntime()) {
      const error = t("mcp.desktop_required");
      setStateField("mcpStatus", error);
      finishPerf(options.developerMode(), "mcp.connect", "blocked", startedAt, {
        reason: "desktop-required",
      });
      return { ok: false, error };
    }

    if (!isRemoteWorkspace && !projectDir && !canUseSofiaServer) {
      const error = t("mcp.pick_workspace_first");
      setStateField("mcpStatus", error);
      finishPerf(options.developerMode(), "mcp.connect", "blocked", startedAt, {
        reason: "missing-workspace",
      });
      return { ok: false, error };
    }

    const activeClient = canUseSofiaServer ? options.client() ?? await ensureActiveClient().catch(() => null) : await ensureActiveClient();
    if (!activeClient && !canUseSofiaServer) {
      const error = t("mcp.connect_server_first");
      setStateField("mcpStatus", error);
      finishPerf(options.developerMode(), "mcp.connect", "blocked", startedAt, {
        reason: "no-active-client",
      });
      return { ok: false, error };
    }

    const resolvedProjectDir = activeClient ? await resolveProjectDir(activeClient, projectDir) : projectDir;
    if (!resolvedProjectDir && !canUseSofiaServer) {
      const error = t("mcp.pick_workspace_first");
      setStateField("mcpStatus", error);
      finishPerf(options.developerMode(), "mcp.connect", "blocked", startedAt, {
        reason: "missing-workspace-after-discovery",
      });
      return { ok: false, error };
    }

    const slug = entry.id ?? getMcpServerName(entry);
    const action = snapshot.mcpServers.some((server) => server.name === slug) ? "updated" : "added";

    if (conflictsWithSofiaConnect(entry)) {
      const error = t("mcp.name_reserved_sofia_connect");
      setStateField("mcpStatus", error);
      finishPerf(options.developerMode(), "mcp.connect", "blocked", startedAt, {
        reason: "sofia-connect-name-reserved",
      });
      return { ok: false, error };
    }

    try {
      mutateState((current) => ({ ...current, mcpStatus: null, mcpConnectingName: entry.name }));

      if (entry.managedBy === "sofia-connect") {
        if (slug !== CLOUD_MCP_SERVER_NAME) {
          throw new Error("Connections MCP metadata is invalid.");
        }
        if (!canUseSofiaServer || !sofiaClient || !sofiaWorkspaceId) {
          throw new Error("Sofia App server is required to repair agent access to connected services.");
        }
        const context = await resolveCloudMcpOperationContext(entry.url);
        if (!context) {
          throw new Error("Sign in to Organization cloud and choose an organization first.");
        }
        clearCloudMcpDisabledIntent(context);
        const result = await runSofiaCloudMcpReconciler({
          mode: "repair",
          client: sofiaClient,
          context: { ...context, trigger: "desktop-explicit-connect" },
          mintToken: mintCloudControlMcpToken,
          force: true,
          refreshMarginMs: CLOUD_MCP_REFRESH_MARGIN_MS,
        });
        await refreshMcpServers();
        if (result.health?.usable) {
          setStateField("mcpStatus", t("mcp.connected"));
          finishPerf(options.developerMode(), "mcp.connect", "done", startedAt, {
            name: entry.name,
            type: entryType,
            slug,
          });
          return { ok: true };
        }
        const summary = cloudMcpDisplaySummary({
          signedIn: Boolean(context.denAuthToken?.trim()),
          orgSelected: Boolean(context.orgId.trim()),
          connecting: false,
          health: result.health,
        });
        setStateField("mcpStatus", `${summary.stageLabel}. ${summary.recommendedAction}`);
        finishPerf(options.developerMode(), "mcp.connect", "error", startedAt, {
          name: entry.name,
          type: entryType,
          error: summary.stageLabel,
        });
        return { ok: false, error: `${summary.stageLabel}. ${summary.recommendedAction}` };
      }

      if (entry.managedOAuth) {
        if (isRemoteWorkspace || !isDesktopRuntime()) {
          throw new Error("Sofia App-managed MCP OAuth is currently available for local desktop workspaces only.");
        }
        if (entryType !== "remote" || !entry.url) {
          throw new Error("Sofia App-managed OAuth requires a remote MCP URL.");
        }
        if (!canUseSofiaServer || !sofiaClient || !sofiaWorkspaceId) {
          throw new Error("The local Sofia App server is required for managed MCP sign-in.");
        }
        const result = await sofiaClient.addManagedMcp(sofiaWorkspaceId, {
          name: slug,
          url: entry.url,
          oauth: {
            applicationType: "native",
            requestedScopes: entry.oauthConfig?.scope?.split(/\s+/).filter(Boolean),
            clientId: entry.oauthConfig?.clientId,
            clientSecret: entry.oauthConfig?.clientSecret,
          },
        });
        const connected = await waitForManagedMcpAuthorization(
          sofiaClient,
          sofiaWorkspaceId,
          slug,
          result,
        );
        options.markReloadRequired?.("mcp", { type: "mcp", name: slug, action });
        await refreshMcpServers();
        if (connected) setStateField("mcpStatus", t("mcp.connected"));
        finishPerf(options.developerMode(), "mcp.connect", connected ? "done" : "blocked", startedAt, {
          name: entry.name,
          type: entryType,
          slug,
        });
        return connected
          ? { ok: true }
          : {
              ok: false,
              error: state.mcpStatus ?? "MCP sign-in is still pending. Finish it in your browser, then refresh connections.",
            };
      }

      // Resolve dynamic URLs for built-in MCPs
      let resolvedUrl = entry.url;
      let resolvedHeaders: Record<string, string> | undefined;
      if (!resolvedUrl && entry.serverName === "sofia-ui") {
        try {
          const bridgeInfo = await window.__SOFIA_ELECTRON__?.invokeDesktop?.("getUiControlBridgeInfo");
          if (bridgeInfo?.baseUrl) {
            resolvedUrl = `${bridgeInfo.baseUrl}/mcp`;
            if (bridgeInfo.token) {
              resolvedHeaders = { Authorization: `Bearer ${bridgeInfo.token}` };
            }
          }
        } catch {
          // Bridge not available
        }
      }

      const mcpEntryConfig: Record<string, unknown> = {
        type: entryType,
        enabled: true,
      };

      if (entryType === "remote") {
        if (!resolvedUrl) {
          throw new Error("Missing MCP URL. Is the Sofia App desktop app running?");
        }
        mcpEntryConfig["url"] = resolvedUrl;
        if (resolvedHeaders) {
          mcpEntryConfig["headers"] = resolvedHeaders;
          // Header-authed entries must not trigger OAuth auto-detection;
          // otherwise engine reports "needs_auth" despite valid headers.
          mcpEntryConfig["oauth"] = false;
        }
        if (!resolvedHeaders) {
          if (entry.oauthConfig) {
            mcpEntryConfig["oauth"] = entry.oauthConfig;
          } else if (entry.oauth) {
            mcpEntryConfig["oauth"] = {};
          }
        }
      }

      if (entryType === "local") {
        if (!entry.command?.length) {
          throw new Error("Missing MCP command.");
        }
        mcpEntryConfig["command"] = await resolveLocalMcpCommand(entry);
        const environment = await resolveLocalMcpEnvironment(entry);
        if (environment) {
          mcpEntryConfig["environment"] = environment;
        }
      }

      if (canUseSofiaServer && sofiaClient && sofiaWorkspaceId) {
        await sofiaClient.addMcp(sofiaWorkspaceId, {
          name: slug,
          config: mcpEntryConfig,
        });
      } else {
        throw new Error(t("mcp.connect_server_first"));
      }

      if (canUseSofiaServer && sofiaClient && sofiaWorkspaceId) {
        // The Sofia App server is the source of truth for workspace-scoped MCP
        // config in the React port. Avoid also calling the Sofia SDK's MCP
        // hot-add endpoint here: when the SDK client is rooted at the aggregate
        // `/engine` route it can resolve to an internal `local_*` workspace
        // id that the Sofia App server does not expose, producing a confusing
        // `workspace_not_found` after the config write already succeeded.
        setStateField("mcpStatuses", filterConfiguredStatuses(snapshot.mcpStatuses, snapshot.mcpServers));
      } else {
        if (!activeClient || !resolvedProjectDir) {
          throw new Error(t("mcp.connect_server_first"));
        }
        const mcpAddConfig =
          entryType === "remote"
            ? {
                type: "remote" as const,
                url: resolvedUrl ?? entry.url!,
                enabled: true,
                ...(resolvedHeaders ? { headers: resolvedHeaders, oauth: false as const } : {}),
                ...(!resolvedHeaders && entry.oauthConfig ? { oauth: entry.oauthConfig } : {}),
                ...(!resolvedHeaders && !entry.oauthConfig && entry.oauth ? { oauth: {} } : {}),
              }
            : {
                type: "local" as const,
                command: (mcpEntryConfig["command"] as string[]) ?? entry.command!,
                enabled: true,
              };

        const status = unwrap(
          await activeClient.mcp.add({
            directory: resolvedProjectDir,
            name: slug,
            config: mcpAddConfig,
          }),
        );

        setStateField("mcpStatuses", status as McpStatusMap);
      }
      options.markReloadRequired?.("mcp", { type: "mcp", name: slug, action });
      await refreshMcpServers();

      // OAuth is auto-detected: open the sign-in modal when the directory
      // entry declares OAuth up front, or when the engine reports the fresh
      // remote entry as needing auth. Custom apps no longer ask the user to
      // know whether their server uses OAuth.
      let needsAuth = Boolean(entry.oauth) && !resolvedHeaders;
      if (!needsAuth && entryType === "remote" && !resolvedHeaders) {
        for (let attempt = 0; attempt < 4; attempt += 1) {
          const detected = snapshot.mcpStatuses[slug]?.status;
          if (detected === "needs_auth" || detected === "needs_client_registration") {
            needsAuth = true;
            break;
          }
          if (detected === "connected" || detected === "failed" || detected === "disabled") break;
          await new Promise((resolve) => setTimeout(resolve, 500));
          await refreshMcpServers();
        }
      }

      if (needsAuth) {
        mutateState((current) => ({
          ...current,
          mcpAuthEntry: entry,
          mcpAuthNeedsReload: true,
          mcpAuthModalOpen: true,
        }));
      } else {
        setStateField("mcpStatus", t("mcp.connected"));
      }

      await refreshMcpServers();
      finishPerf(options.developerMode(), "mcp.connect", "done", startedAt, {
        name: entry.name,
        type: entryType,
        slug,
      });
      return { ok: true };
    } catch (error) {
      console.error("[mcp.connect] failed", entry.name, error);
      const message = error instanceof Error ? error.message : t("mcp.connect_failed");
      setStateField("mcpStatus", message);
      finishPerf(options.developerMode(), "mcp.connect", "error", startedAt, {
        name: entry.name,
        type: entryType,
        error: error instanceof Error ? error.message : safeStringify(error),
      });
      return { ok: false, error: message };
    } finally {
      setStateField("mcpConnectingName", null);
    }
  }

  /**
   * Background reconciliation for the Den cloud MCP: when the desktop is
   * signed in to Organization cloud with an active org, keep the
   * `sofia-cloud` MCP entry configured with a fresh first-party token.
   * Quiet by design — a failed mint never opens the OAuth modal.
   *
   * `force` bypasses the freshness marker: used by the user-facing Refresh
   * button so "make my cloud connection current NOW" is one click (re-mint
   * token + rewrite config + reconnect) instead of sign-out/sign-in or
   * waiting for the marker to expire.
   */
  async function syncCloudControlMcp(options?: { force?: boolean }): Promise<"synced" | "unchanged" | "skipped"> {
    const settings = readDenSettings();
    const orgId = settings.activeOrgId?.trim() ?? "";
    if (!orgId || !settings.authToken?.trim()) return "skipped";
    const workspaceId = await resolveSofiaWorkspaceId();
    if (!workspaceId) return "skipped";
    const sofiaClient = getSofiaSnapshot().sofiaServerClient;
    const serverBaseUrl = sofiaClient?.baseUrl.trim() ?? "";
    if (!sofiaClient || !serverBaseUrl) return "skipped";

    const entry = MCP_QUICK_CONNECT.find((candidate) => candidate.serverName === CLOUD_MCP_SERVER_NAME);
    if (!entry) return "skipped";
    const scope = { denBaseUrl: settings.baseUrl, serverBaseUrl, orgId, workspaceId };

    // Respect explicit user intent for this exact workspace/org/server/deployment.
    if (readCloudMcpUserState(scope) !== null) return "skipped";
    const configuredEntry = snapshot.mcpServers.find((server) => server.name === CLOUD_MCP_SERVER_NAME);
    if (configuredEntry?.config.enabled === false) return "skipped";

    const result = await runSofiaCloudMcpReconciler({
      mode: "repair",
      client: sofiaClient,
      context: {
        ...scope,
        denAuthToken: settings.authToken,
        orgSlug: settings.activeOrgSlug,
        orgName: settings.activeOrgName,
        fallbackUrl: configuredEntry?.config.url ?? entry.url,
        trigger: options?.force ? "desktop-settings-force" : "desktop-settings-background",
      },
      mintToken: mintCloudControlMcpToken,
      force: options?.force,
      refreshMarginMs: CLOUD_MCP_REFRESH_MARGIN_MS,
    });
    if (result.status === "unchanged" || result.status === "ready") return "unchanged";
    if (result.health?.usable) {
      await refreshMcpServers();
      return "synced";
    }
    return "skipped";
  }

  async function waitForManagedMcpAuthorization(
    sofiaClient: SofiaServerClient,
    workspaceId: string,
    name: string,
    result: { status: "connected" } | { status: "needs_auth"; authorizeUrl: string },
  ): Promise<boolean> {
    if (result.status === "connected") return true;
    await openDesktopUrl(assertDesktopWebUrl(result.authorizeUrl));
    for (let attempt = 0; attempt < 120; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      const connection = await sofiaClient.getManagedMcp(workspaceId, name);
      if (connection.status === "connected") return true;
      if (connection.status === "reconnect_required") {
        throw new Error(connection.lastError || "MCP sign-in needs to be restarted.");
      }
    }
    setStateField("mcpStatus", "MCP sign-in is still pending. Finish it in your browser, then refresh connections.");
    return false;
  }

  async function authorizeMcp(entry: McpServerEntry) {
    if (entry.managedOAuth) {
      try {
        const { sofiaClient, sofiaWorkspaceId, canUseSofiaServer } = await resolveWritableSofiaTarget();
        if (!canUseSofiaServer || !sofiaClient || !sofiaWorkspaceId) {
          throw new Error("The local Sofia App server is required for managed MCP sign-in.");
        }
        mutateState((current) => ({ ...current, mcpStatus: null, mcpConnectingName: entry.name }));
        const result = await sofiaClient.connectManagedMcp(sofiaWorkspaceId, entry.name);
        const connected = await waitForManagedMcpAuthorization(sofiaClient, sofiaWorkspaceId, entry.name, result);
        await refreshMcpServers();
        if (connected) setStateField("mcpStatus", t("mcp.connected"));
      } catch (error) {
        setStateField("mcpStatus", error instanceof Error ? error.message : t("mcp.connect_failed"));
      } finally {
        setStateField("mcpConnectingName", null);
      }
      return;
    }
    if (entry.config.type !== "remote" || entry.config.oauth === false) {
      setStateField("mcpStatus", t("mcp.login_unavailable"));
      return;
    }

    const matchingQuickConnect = MCP_QUICK_CONNECT.find((candidate) => {
      const candidateSlug = candidate.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      return candidateSlug === entry.name || candidate.name === entry.name;
    });

    mutateState((current) => ({
      ...current,
      mcpAuthEntry:
        matchingQuickConnect ?? {
          name: entry.name,
          description: "",
          type: "remote",
          url: entry.config.url,
          oauth: true,
        },
      mcpAuthNeedsReload: false,
      mcpAuthModalOpen: true,
    }));
  }

  async function logoutMcpAuth(name: string) {
    const sofiaSnapshot = getSofiaSnapshot();
    const isRemoteWorkspace =
      options.workspaceType() === "remote" ||
      (!isDesktopRuntime() && sofiaSnapshot.sofiaServerStatus === "connected");
    const projectDir = options.projectDir().trim();

    const { sofiaClient, sofiaWorkspaceId, hasSofiaTarget, canUseSofiaServer } =
      await resolveWritableSofiaTarget();

    if (isRemoteWorkspace && !canUseSofiaServer) {
      setStateField("mcpStatus", "Sofia App server unavailable. MCP auth is read-only.");
      return;
    }

    if (hasSofiaTarget && !canUseSofiaServer) {
      setStateField("mcpStatus", "Sofia App server MCP auth is read-only.");
      return;
    }

    if (!canUseSofiaServer && !isDesktopRuntime()) {
      setStateField("mcpStatus", t("mcp.desktop_required"));
      return;
    }

    const activeClient = canUseSofiaServer ? options.client() : await ensureActiveClient();
    if (!activeClient && !canUseSofiaServer) {
      setStateField("mcpStatus", t("mcp.connect_server_first"));
      return;
    }

    const resolvedProjectDir = activeClient ? await resolveProjectDir(activeClient, projectDir) : projectDir;
    if (!resolvedProjectDir && !canUseSofiaServer) {
      setStateField("mcpStatus", t("mcp.pick_workspace_first"));
      return;
    }

    const safeName = validateMcpServerName(name);
    setStateField("mcpStatus", null);

    try {
      if (canUseSofiaServer && sofiaClient && sofiaWorkspaceId) {
        await sofiaClient.logoutMcpAuth(sofiaWorkspaceId, safeName);
      } else {
        if (!activeClient || !resolvedProjectDir) {
          throw new Error(t("mcp.connect_server_first"));
        }
        try {
          await activeClient.mcp.disconnect({ directory: resolvedProjectDir, name: safeName });
        } catch {
          // ignore
        }
        await activeClient.mcp.auth.remove({ directory: resolvedProjectDir, name: safeName });
      }

      try {
        if (activeClient && resolvedProjectDir) {
          const status = unwrap(await activeClient.mcp.status({ directory: resolvedProjectDir }));
          setStateField("mcpStatuses", status as McpStatusMap);
        }
      } catch {
        // ignore
      }

      await refreshMcpServers();
      setStateField("mcpStatus", t("mcp.logout_success").replace("{server}", safeName));
    } catch (error) {
      setStateField(
        "mcpStatus",
        error instanceof Error ? error.message : t("mcp.logout_failed"),
      );
    }
  }

  async function removeMcp(name: string) {
    try {
      setStateField("mcpStatus", null);

      const { sofiaClient, sofiaWorkspaceId, hasSofiaTarget, canUseSofiaServer } =
        await resolveWritableSofiaTarget();

      if (canUseSofiaServer && sofiaClient && sofiaWorkspaceId) {
        await sofiaClient.removeMcp(sofiaWorkspaceId, name);
      } else {
        if (hasSofiaTarget) {
          setStateField("mcpStatus", "Sofia App server MCP config is read-only.");
          return;
        }
        setStateField("mcpStatus", t("mcp.connect_server_first"));
        return;
      }

      if (name === CLOUD_MCP_SERVER_NAME) {
        const context = await resolveCloudMcpOperationContext(null);
        if (context) recordCloudMcpDisabledIntent(context, "removed");
      }
      options.markReloadRequired?.("mcp", { type: "mcp", name, action: "removed" });
      await refreshMcpServers();
      if (snapshot.selectedMcp === name) {
        setStateField("selectedMcp", null);
      }
      setStateField("mcpStatus", null);
    } catch (error) {
      setStateField(
        "mcpStatus",
        error instanceof Error ? error.message : t("mcp.remove_failed"),
      );
    }
  }

  function notifyMcpReloading() {
    setStateField("mcpStatus", t("mcp.reloading_status"));
  }

  // Sofia reconnects MCP servers asynchronously after /instance/dispose,
  // so an immediate mcp.status query returns stale "disconnected". Poll on
  // a backoff until every enabled MCP reaches a terminal status, with the
  // banner up the whole time so users see continuous feedback.
  async function pollMcpServersAfterReload(): Promise<void> {
    if (disposed) return;
    notifyMcpReloading();
    await refreshMcpServers();

    const settled = (statuses: McpStatusMap, servers: McpServerEntry[]) => {
      const expected = servers.filter((s) => s.config.enabled !== false);
      if (expected.length === 0) return true;
      return expected.every((server) => {
        const status = statuses[server.name]?.status;
        return status === "connected" || status === "needs_auth" || status === "failed";
      });
    };

    const delays = [400, 800, 1500, 2500, 4000];
    for (const delay of delays) {
      if (disposed) return;
      if (settled(snapshot.mcpStatuses, snapshot.mcpServers)) break;
      await new Promise((resolve) => setTimeout(resolve, delay));
      await refreshMcpServers();
    }

    if (disposed) return;
    // Only clear the reloading banner if it's still ours. refreshMcpServers
    // may have already replaced it with a real message (e.g. "No MCP servers").
    if (snapshot.mcpStatus === t("mcp.reloading_status")) {
      setStateField("mcpStatus", null);
    }
  }

  // Server-only path. Local fallback would rewrite engine.jsonc whole and
  // clobber inline comments — settings-route.tsx already gates the prop so
  // this never gets called when the server is unavailable. Reload UX comes
  // from the existing reload-required popup; no extra banner here.
  async function setMcpEnabled(name: string, enabled: boolean) {
    try {
      const { sofiaClient, sofiaWorkspaceId, canUseSofiaServer } =
        await resolveWritableSofiaTarget();

      if (!canUseSofiaServer || !sofiaClient || !sofiaWorkspaceId) {
        setStateField("mcpStatus", t("mcp.toggle_requires_server"));
        return;
      }

      await sofiaClient.setMcpEnabled(sofiaWorkspaceId, name, enabled);
      if (name === CLOUD_MCP_SERVER_NAME) {
        const context = await resolveCloudMcpOperationContext(null);
        if (enabled) {
          if (context) clearCloudMcpDisabledIntent(context);
        } else if (context) {
          recordCloudMcpDisabledIntent(context, "disabled");
        }
      }
      options.markReloadRequired?.("mcp", { type: "mcp", name, action: "updated" });
      await refreshMcpServers();
    } catch (error) {
      setStateField(
        "mcpStatus",
        error instanceof Error ? error.message : t("mcp.toggle_failed"),
      );
    }
  }

  function closeMcpAuthModal() {
    mutateState((current) => ({
      ...current,
      mcpAuthModalOpen: false,
      mcpAuthEntry: null,
      mcpAuthNeedsReload: false,
    }));
  }

  async function completeMcpAuthModal() {
    closeMcpAuthModal();
    await refreshMcpServers();
  }

  const syncFromOptions = () => {
    const workspaceContextKey = getWorkspaceContextKey();
    const projectDir = options.projectDir().trim();
    const changed =
      workspaceContextKey !== lastWorkspaceContextKey || projectDir !== lastProjectDir;

    lastWorkspaceContextKey = workspaceContextKey;
    lastProjectDir = projectDir;

    if (!started || disposed || !changed) {
      return;
    }

    if (!isDesktopRuntime() && getSofiaSnapshot().sofiaServerStatus !== "connected") {
      return;
    }

    void refreshMcpServers();
  };

  const start = () => {
    if (started) return;
    // StrictMode double-mount re-arms after dispose.
    disposed = false;
    started = true;
    syncFromOptions();
  };

  const dispose = () => {
    disposed = true;
    started = false;
  };

  refreshSnapshot();

  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const getSnapshot = () => snapshot;

  return {
    subscribe,
    getSnapshot,
    start,
    dispose,
    syncFromOptions,
    get mcpServers() {
      return snapshot.mcpServers;
    },
    get mcpStatus() {
      return snapshot.mcpStatus;
    },
    get mcpLastUpdatedAt() {
      return snapshot.mcpLastUpdatedAt;
    },
    get mcpStatuses() {
      return snapshot.mcpStatuses;
    },
    get mcpConnectingName() {
      return snapshot.mcpConnectingName;
    },
    get selectedMcp() {
      return snapshot.selectedMcp;
    },
    setSelectedMcp(value: SetStateAction<string | null>) {
      const resolved = applyStateAction(state.selectedMcp, value);
      setStateField("selectedMcp", resolved);
    },
    quickConnect: MCP_QUICK_CONNECT,
    refreshMcpServers,
    connectMcp,
    syncCloudControlMcp,
    authorizeMcp,
    logoutMcpAuth,
    removeMcp,
    setMcpEnabled,
    notifyMcpReloading,
    pollMcpServersAfterReload,
    get mcpAuthModalOpen() {
      return snapshot.mcpAuthModalOpen;
    },
    get mcpAuthEntry() {
      return snapshot.mcpAuthEntry;
    },
    get mcpAuthNeedsReload() {
      return snapshot.mcpAuthNeedsReload;
    },
    closeMcpAuthModal,
    completeMcpAuthModal,
  };
}

export function useConnectionsStoreSnapshot(store: ConnectionsStore) {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
