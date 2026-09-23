import { useSyncExternalStore } from "react";

import { t } from "../../../i18n";
import type { StartupPreference, WorkspaceDisplay } from "../../../app/types";
import { isDesktopRuntime } from "../../../app/utils";
import {
  sofiaServerInfo,
  sofiaServerRestart,
  type SofiaServerInfo,
} from "../../../app/lib/desktop";
import {
  getSofiaGatewayOrigin,
  readSofiaGatewayDenToken,
} from "../../../app/lib/gateway-runtime";
import {
  clearSofiaServerSettings,
  createSofiaServerClient,
  isLoopbackSofiaServerUrl,
  normalizeSofiaServerUrl,
  readSofiaServerSettings,
  writeSofiaServerSettings,
  type SofiaAuditEntry,
  type SofiaServerCapabilities,
  type SofiaServerClient,
  type SofiaServerDiagnostics,
  type SofiaServerError,
  type SofiaServerSettings,
  type SofiaServerStatus,
} from "../../../app/lib/sofia-server";

type SetStateAction<T> = T | ((current: T) => T);

type RemoteWorkspaceInput = {
  sofiaHostUrl: string;
  sofiaToken?: string | null;
  directory?: string | null;
  displayName?: string | null;
};

export type SofiaServerStoreSnapshot = {
  sofiaServerSettings: SofiaServerSettings;
  shareRemoteAccessBusy: boolean;
  shareRemoteAccessError: string | null;
  sofiaServerUrl: string;
  sofiaServerBaseUrl: string;
  sofiaServerAuth: { token?: string; hostToken?: string };
  sofiaServerClient: SofiaServerClient | null;
  sofiaServerStatus: SofiaServerStatus;
  sofiaServerCapabilities: SofiaServerCapabilities | null;
  sofiaServerReady: boolean;
  sofiaServerWorkspaceReady: boolean;
  resolvedSofiaCapabilities: SofiaServerCapabilities | null;
  sofiaServerCanWriteSkills: boolean;
  sofiaServerCanWritePlugins: boolean;
  sofiaServerHostInfo: SofiaServerInfo | null;
  sofiaServerDiagnostics: SofiaServerDiagnostics | null;
  sofiaReconnectBusy: boolean;
  sofiaAuditEntries: SofiaAuditEntry[];
  sofiaAuditStatus: "idle" | "loading" | "error";
  sofiaAuditError: string | null;
  devtoolsWorkspaceId: string | null;
};

export type SofiaServerStore = ReturnType<typeof createSofiaServerStore>;

type CreateSofiaServerStoreOptions = {
  startupPreference: () => StartupPreference | null;
  documentVisible: () => boolean;
  developerMode: () => boolean;
  runtimeWorkspaceId: () => string | null;
  activeClient: () => unknown | null;
  selectedWorkspaceDisplay: () => WorkspaceDisplay;
  restartLocalServer: () => Promise<boolean>;
  createRemoteWorkspaceFlow: (input: RemoteWorkspaceInput) => Promise<boolean>;
};

type MutableState = {
  sofiaServerSettings: SofiaServerSettings;
  shareRemoteAccessBusy: boolean;
  shareRemoteAccessError: string | null;
  sofiaServerUrl: string;
  sofiaServerStatus: SofiaServerStatus;
  sofiaServerCapabilities: SofiaServerCapabilities | null;
  sofiaServerCheckedAt: number | null;
  sofiaServerHostInfo: SofiaServerInfo | null;
  sofiaServerHostInfoReady: boolean;
  sofiaServerDiagnostics: SofiaServerDiagnostics | null;
  sofiaReconnectBusy: boolean;
  sofiaAuditEntries: SofiaAuditEntry[];
  sofiaAuditStatus: "idle" | "loading" | "error";
  sofiaAuditError: string | null;
  devtoolsWorkspaceId: string | null;
};

const applyStateAction = <T,>(current: T, next: SetStateAction<T>) =>
  typeof next === "function" ? (next as (value: T) => T)(current) : next;

export function createSofiaServerStore(options: CreateSofiaServerStoreOptions) {
  const bootStartedAt = Date.now();
  const listeners = new Set<() => void>();
  const intervals = new Map<string, number>();

  let clientCacheKey = "";
  let clientCacheValue: SofiaServerClient | null = null;
  let started = false;
  let disposed = false;
  let healthTimeoutId: number | null = null;
  let healthBusy = false;
  let healthDelayMs = 10_000;
  let consecutiveHealthFailures = 0;
  let visibilityChangeHandler: (() => void) | null = null;
  let snapshot: SofiaServerStoreSnapshot;

  let state: MutableState = {
    sofiaServerSettings: readSofiaServerSettings(),
    shareRemoteAccessBusy: false,
    shareRemoteAccessError: null,
    sofiaServerUrl: "",
    sofiaServerStatus: "disconnected",
    sofiaServerCapabilities: null,
    sofiaServerCheckedAt: null,
    sofiaServerHostInfo: null,
    sofiaServerHostInfoReady: !isDesktopRuntime(),
    sofiaServerDiagnostics: null,
    sofiaReconnectBusy: false,
    sofiaAuditEntries: [],
    sofiaAuditStatus: "idle",
    sofiaAuditError: null,
    devtoolsWorkspaceId: null,
  };

  const emitChange = () => {
    for (const listener of listeners) listener();
  };

  const getBaseUrl = () => {
    const gatewayOrigin = getSofiaGatewayOrigin();
    if (gatewayOrigin) return normalizeSofiaServerUrl(gatewayOrigin) ?? "";

    const pref = options.startupPreference();
    const hostInfo = state.sofiaServerHostInfo;
    const settingsUrl = normalizeSofiaServerUrl(state.sofiaServerSettings.urlOverride ?? "") ?? "";

    if (pref === "local") return hostInfo?.baseUrl ?? "";
    if (pref === "server" && settingsUrl && isLoopbackSofiaServerUrl(settingsUrl) && hostInfo?.baseUrl) {
      return hostInfo.baseUrl;
    }
    if (pref === "server") return settingsUrl;
    return hostInfo?.baseUrl ?? settingsUrl;
  };

  const getAuth = () => {
    const gatewayOrigin = getSofiaGatewayOrigin();
    if (gatewayOrigin) {
      const token = readSofiaGatewayDenToken().trim();
      return { token: token || undefined, hostToken: undefined };
    }

    const pref = options.startupPreference();
    const hostInfo = state.sofiaServerHostInfo;
    const settingsUrl = normalizeSofiaServerUrl(state.sofiaServerSettings.urlOverride ?? "") ?? "";
    const settingsToken = state.sofiaServerSettings.token?.trim() ?? "";
    const settingsHostToken = state.sofiaServerSettings.hostToken?.trim() ?? "";
    const clientToken = hostInfo?.clientToken?.trim() ?? "";
    const hostToken = hostInfo?.hostToken?.trim() ?? "";

    if (pref === "local") {
      return { token: clientToken || undefined, hostToken: hostToken || undefined };
    }
    if (pref === "server" && settingsUrl && isLoopbackSofiaServerUrl(settingsUrl) && hostInfo?.baseUrl) {
      return {
        token: clientToken || settingsToken || undefined,
        hostToken: hostToken || settingsHostToken || undefined,
      };
    }
    if (pref === "server") {
      return {
        token: settingsToken || undefined,
        hostToken: settingsUrl && isLoopbackSofiaServerUrl(settingsUrl) ? settingsHostToken || undefined : undefined,
      };
    }
    if (hostInfo?.baseUrl) {
      return { token: clientToken || undefined, hostToken: hostToken || undefined };
    }
    return {
      token: settingsToken || undefined,
      hostToken: settingsUrl && isLoopbackSofiaServerUrl(settingsUrl) ? settingsHostToken || undefined : undefined,
    };
  };

  const getClient = () => {
    const baseUrl = getBaseUrl().trim();
    if (!baseUrl) {
      clientCacheKey = "";
      clientCacheValue = null;
      return null;
    }

    const auth = getAuth();
    const key = `${baseUrl}::${auth.token ?? ""}::${auth.hostToken ?? ""}`;
    if (key !== clientCacheKey) {
      clientCacheKey = key;
      clientCacheValue = createSofiaServerClient({
        baseUrl,
        token: auth.token,
        hostToken: auth.hostToken,
      });
    }
    return clientCacheValue;
  };

  const refreshSnapshot = () => {
    const sofiaServerBaseUrl = getBaseUrl().trim();
    const sofiaServerAuth = getAuth();
    const sofiaServerClient = getClient();
    const sofiaServerReady = state.sofiaServerStatus === "connected";
    const sofiaServerWorkspaceReady = Boolean(options.runtimeWorkspaceId());
    const resolvedSofiaCapabilities = state.sofiaServerCapabilities;

    const pref = options.startupPreference();
    const info = state.sofiaServerHostInfo;
    const hostUrl = info?.connectUrl ?? info?.lanUrl ?? info?.mdnsUrl ?? info?.baseUrl ?? "";
    const settingsUrl = normalizeSofiaServerUrl(state.sofiaServerSettings.urlOverride ?? "") ?? "";

    let sofiaServerUrl = hostUrl || settingsUrl;
    if (pref === "local") sofiaServerUrl = hostUrl;
    if (pref === "server") sofiaServerUrl = settingsUrl;
    state.sofiaServerUrl = sofiaServerUrl;

    snapshot = {
      sofiaServerSettings: state.sofiaServerSettings,
      shareRemoteAccessBusy: state.shareRemoteAccessBusy,
      shareRemoteAccessError: state.shareRemoteAccessError,
      sofiaServerUrl,
      sofiaServerBaseUrl,
      sofiaServerAuth,
      sofiaServerClient,
      sofiaServerStatus: state.sofiaServerStatus,
      sofiaServerCapabilities: state.sofiaServerCapabilities,
      sofiaServerReady,
      sofiaServerWorkspaceReady,
      resolvedSofiaCapabilities,
      sofiaServerCanWriteSkills:
        sofiaServerReady &&
        (resolvedSofiaCapabilities?.skills?.write ?? false),
      sofiaServerCanWritePlugins:
        sofiaServerReady &&
        (resolvedSofiaCapabilities?.plugins?.write ?? false),
      sofiaServerHostInfo: state.sofiaServerHostInfo,
      sofiaServerDiagnostics: state.sofiaServerDiagnostics,
      sofiaReconnectBusy: state.sofiaReconnectBusy,
      sofiaAuditEntries: state.sofiaAuditEntries,
      sofiaAuditStatus: state.sofiaAuditStatus,
      sofiaAuditError: state.sofiaAuditError,
      devtoolsWorkspaceId: state.devtoolsWorkspaceId,
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

  const setSofiaServerSettings = (next: SetStateAction<SofiaServerSettings>) => {
    const resolved = applyStateAction(state.sofiaServerSettings, next);
    mutateState((current) => ({ ...current, sofiaServerSettings: resolved }));
    queueHealthCheck(0);
  };

  const updateSofiaServerSettings = (next: SofiaServerSettings) => {
    const stored = writeSofiaServerSettings(next);
    mutateState((current) => ({ ...current, sofiaServerSettings: stored }));
    queueHealthCheck(0);
  };

  const resetSofiaServerSettings = () => {
    clearSofiaServerSettings();
    mutateState((current) => ({ ...current, sofiaServerSettings: {} }));
    queueHealthCheck(0);
  };

  const shouldWaitForLocalHostInfo = () =>
    isDesktopRuntime() &&
    options.startupPreference() !== "server" &&
    !state.sofiaServerHostInfoReady;

  const shouldRetryStartupCheck = (status: SofiaServerStatus) =>
    status !== "connected" &&
    isDesktopRuntime() &&
    options.startupPreference() !== "server" &&
    Date.now() - bootStartedAt < 5_000;

  const checkSofiaServer = async (url: string, token?: string, hostToken?: string) => {
    const client = createSofiaServerClient({ baseUrl: url, token, hostToken });
    try {
      await client.health();
    } catch (error) {
      const resolved = error as SofiaServerError | Error;
      if ("status" in resolved && (resolved.status === 401 || resolved.status === 403)) {
        return { status: "limited" as SofiaServerStatus, capabilities: null };
      }
      return { status: "disconnected" as SofiaServerStatus, capabilities: null };
    }

    if (!token) {
      return { status: "limited" as SofiaServerStatus, capabilities: null };
    }

    try {
      const capabilities = await client.capabilities();
      return { status: "connected" as SofiaServerStatus, capabilities };
    } catch (error) {
      const resolved = error as SofiaServerError | Error;
      if ("status" in resolved && (resolved.status === 401 || resolved.status === 403)) {
        return { status: "limited" as SofiaServerStatus, capabilities: null };
      }
      return { status: "disconnected" as SofiaServerStatus, capabilities: null };
    }
  };

  const clearHealthTimeout = () => {
    if (healthTimeoutId !== null) {
      window.clearTimeout(healthTimeoutId);
      healthTimeoutId = null;
    }
  };

  const queueHealthCheck = (delayMs: number) => {
    if (disposed || typeof window === "undefined") return;
    clearHealthTimeout();
    healthTimeoutId = window.setTimeout(() => {
      healthTimeoutId = null;
      void runHealthCheck();
    }, Math.max(0, delayMs));
  };

  const runHealthCheck = async () => {
    if (disposed || typeof window === "undefined") return;
    if (!options.documentVisible()) {
      queueHealthCheck(healthDelayMs);
      return;
    }
    if (shouldWaitForLocalHostInfo()) {
      queueHealthCheck(250);
      return;
    }
    if (healthBusy) return;

    const url = getBaseUrl().trim();
    const auth = getAuth();
    if (!url) {
      consecutiveHealthFailures = 0;
      mutateState((current) => ({
        ...current,
        sofiaServerStatus: "disconnected",
        sofiaServerCapabilities: null,
        sofiaServerCheckedAt: Date.now(),
      }));
      return;
    }

    healthBusy = true;
    try {
      let result = await checkSofiaServer(url, auth.token, auth.hostToken);

      if (shouldRetryStartupCheck(result.status)) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 250));
        if (disposed) return;

        try {
          const info = await sofiaServerInfo() as SofiaServerInfo;
          if (disposed) return;

          mutateState((current) => ({
            ...current,
            sofiaServerHostInfo: info,
            sofiaServerHostInfoReady: true,
          }));

          const retryUrl = info.baseUrl?.trim() ?? "";
          const retryToken = info.clientToken?.trim() || undefined;
          const retryHostToken = info.hostToken?.trim() || undefined;
          if (retryUrl) {
            result = await checkSofiaServer(retryUrl, retryToken, retryHostToken);
          }
        } catch {
          // Preserve the original check result when the retry probe fails.
        }
      }

      if (disposed) return;
      const previousStatus = state.sofiaServerStatus;
      const previousCapabilities = state.sofiaServerCapabilities;
      const healthy = result.status === "connected" || result.status === "limited";
      if (healthy) {
        consecutiveHealthFailures = 0;
        healthDelayMs = 10_000;
      } else {
        consecutiveHealthFailures += 1;
        healthDelayMs = Math.min(healthDelayMs * 2, 60_000);
      }

      const preservePrevious =
        !healthy &&
        consecutiveHealthFailures < 3 &&
        (previousStatus === "connected" || previousStatus === "limited");

      mutateState((current) => ({
        ...current,
        sofiaServerStatus: preservePrevious ? previousStatus : result.status,
        sofiaServerCapabilities: preservePrevious ? previousCapabilities : result.capabilities,
        sofiaServerCheckedAt: Date.now(),
      }));
    } catch {
      healthDelayMs = Math.min(healthDelayMs * 2, 60_000);
      mutateState((current) => ({
        ...current,
        sofiaServerCheckedAt: Date.now(),
      }));
    } finally {
      healthBusy = false;
      if (!disposed) queueHealthCheck(healthDelayMs);
    }
  };

  const syncFromOptions = () => {
    refreshSnapshot();
    emitChange();

    if (!isDesktopRuntime()) return;
    const port = state.sofiaServerHostInfo?.port;
    if (!port) return;
    if (state.sofiaServerSettings.portOverride === port) return;

    updateSofiaServerSettings({
      ...state.sofiaServerSettings,
      portOverride: port,
    });
  };

  const startInterval = (key: string, fn: () => void, ms: number) => {
    if (typeof window === "undefined") return;
    if (intervals.has(key)) return;
    intervals.set(key, window.setInterval(fn, ms));
  };

  const stopInterval = (key: string) => {
    const id = intervals.get(key);
    if (id === undefined) return;
    window.clearInterval(id);
    intervals.delete(key);
  };

  const start = () => {
    if (typeof window === "undefined") return;
    if (started) return;
    // Allow restart after a prior dispose() (React 18 StrictMode double-mounts
    // each effect in dev: mount → dispose → re-mount). If we early-return when
    // `disposed` is true, the real mount never arms polling and the UI stays
    // on stale/empty state forever.
    disposed = false;
    started = true;

    syncFromOptions();
    queueHealthCheck(0);
    visibilityChangeHandler = () => {
      if (!options.documentVisible()) return;
      consecutiveHealthFailures = 0;
      queueHealthCheck(0);
    };
    window.addEventListener("visibilitychange", visibilityChangeHandler);

    const refreshHostInfo = () => {
      if (!isDesktopRuntime()) return;
      if (!options.documentVisible()) return;
      void (async () => {
        try {
          const info = await sofiaServerInfo() as SofiaServerInfo;
          if (disposed) return;
          mutateState((current) => ({
            ...current,
            sofiaServerHostInfo: info,
            sofiaServerHostInfoReady: true,
          }));
        } catch {
          if (disposed) return;
          mutateState((current) => ({
            ...current,
            sofiaServerHostInfo: null,
            sofiaServerHostInfoReady: true,
          }));
        }
      })();
    };
    refreshHostInfo();
    startInterval("hostInfo", refreshHostInfo, 10_000);

    const refreshDiagnostics = () => {
      if (!options.documentVisible()) return;
      if (!options.developerMode()) {
        setStateField("sofiaServerDiagnostics", null);
        return;
      }

      const client = getClient();
      if (!client || state.sofiaServerStatus === "disconnected") {
        setStateField("sofiaServerDiagnostics", null);
        return;
      }

      void (async () => {
        try {
          const status = await client.status();
          if (!disposed) setStateField("sofiaServerDiagnostics", status);
        } catch {
          if (!disposed) setStateField("sofiaServerDiagnostics", null);
        }
      })();
    };
    refreshDiagnostics();
    startInterval("diagnostics", refreshDiagnostics, 10_000);

    const refreshDevtoolsWorkspace = () => {
      if (!options.documentVisible()) return;
      if (!options.developerMode()) {
        setStateField("devtoolsWorkspaceId", null);
        return;
      }

      const client = getClient();
      if (!client) {
        setStateField("devtoolsWorkspaceId", null);
        return;
      }

      void (async () => {
        try {
          const response = await client.listWorkspaces();
          if (disposed) return;
          const items = Array.isArray(response.items) ? response.items : [];
          const activeMatch = response.activeId
            ? items.find((item) => item.id === response.activeId)
            : null;
          setStateField("devtoolsWorkspaceId", activeMatch?.id ?? items[0]?.id ?? null);
        } catch {
          if (!disposed) setStateField("devtoolsWorkspaceId", null);
        }
      })();
    };
    refreshDevtoolsWorkspace();
    startInterval("devtoolsWorkspace", refreshDevtoolsWorkspace, 20_000);

    const refreshAudit = () => {
      if (!options.documentVisible()) return;
      if (!options.developerMode()) {
        mutateState((current) => ({
          ...current,
          sofiaAuditEntries: [],
          sofiaAuditStatus: "idle",
          sofiaAuditError: null,
        }));
        return;
      }

      const client = getClient();
      const workspaceId = state.devtoolsWorkspaceId;
      if (!client || !workspaceId) {
        mutateState((current) => ({
          ...current,
          sofiaAuditEntries: [],
          sofiaAuditStatus: "idle",
          sofiaAuditError: null,
        }));
        return;
      }

      mutateState((current) => ({
        ...current,
        sofiaAuditStatus: "loading",
        sofiaAuditError: null,
      }));

      void (async () => {
        try {
          const result = await client.listAudit(workspaceId, 50);
          if (disposed) return;
          mutateState((current) => ({
            ...current,
            sofiaAuditEntries: Array.isArray(result.items) ? result.items : [],
            sofiaAuditStatus: "idle",
          }));
        } catch (error) {
          if (disposed) return;
          mutateState((current) => ({
            ...current,
            sofiaAuditEntries: [],
            sofiaAuditStatus: "error",
            sofiaAuditError:
              error instanceof Error
                ? error.message
                : t("app.error_audit_load"),
          }));
        }
      })();
    };
    refreshAudit();
    startInterval("audit", refreshAudit, 15_000);
  };

  const dispose = () => {
    disposed = true;
    started = false;
    clearHealthTimeout();
    if (visibilityChangeHandler && typeof window !== "undefined") {
      window.removeEventListener("visibilitychange", visibilityChangeHandler);
      visibilityChangeHandler = null;
    }
    for (const key of [...intervals.keys()]) stopInterval(key);
  };

  const testSofiaServerConnection = async (next: SofiaServerSettings) => {
    const derived = normalizeSofiaServerUrl(next.urlOverride ?? "");
    if (!derived) {
      mutateState((current) => ({
        ...current,
        sofiaServerStatus: "disconnected",
        sofiaServerCapabilities: null,
        sofiaServerCheckedAt: Date.now(),
      }));
      return false;
    }

    const result = await checkSofiaServer(derived, next.token);
    consecutiveHealthFailures = result.status === "disconnected" ? consecutiveHealthFailures + 1 : 0;
    mutateState((current) => ({
      ...current,
      sofiaServerStatus: result.status,
      sofiaServerCapabilities: result.capabilities,
      sofiaServerCheckedAt: Date.now(),
    }));

    const ok = result.status === "connected" || result.status === "limited";
    if (ok && !isDesktopRuntime()) {
      const active = options.selectedWorkspaceDisplay();
      const shouldAttach =
        !options.activeClient() ||
        active.workspaceType !== "remote" ||
        active.remoteType !== "sofia";
      if (shouldAttach) {
        await options
          .createRemoteWorkspaceFlow({
            sofiaHostUrl: derived,
            sofiaToken: next.token ?? null,
          })
          .catch(() => undefined);
      }
    }
    return ok;
  };

  const reconnectSofiaServer = async () => {
    if (state.sofiaReconnectBusy) return false;
    setStateField("sofiaReconnectBusy", true);

    try {
      let hostInfo = state.sofiaServerHostInfo;
      if (isDesktopRuntime()) {
        try {
          hostInfo = await sofiaServerInfo() as SofiaServerInfo;
          mutateState((current) => ({ ...current, sofiaServerHostInfo: hostInfo }));
        } catch {
          hostInfo = null;
          setStateField("sofiaServerHostInfo", null);
        }
      }

      if (hostInfo?.clientToken?.trim() && options.startupPreference() !== "server") {
        const liveToken = hostInfo.clientToken.trim();
        const liveHostToken = hostInfo.hostToken?.trim() ?? "";
        const settings = state.sofiaServerSettings;
        if (
          (settings.token?.trim() ?? "") !== liveToken ||
          (settings.hostToken?.trim() ?? "") !== liveHostToken
        ) {
          updateSofiaServerSettings({
            ...settings,
            token: liveToken,
            hostToken: liveHostToken || undefined,
          });
        }
      }

      const url = getBaseUrl().trim();
      const auth = getAuth();
      if (!url) {
        mutateState((current) => ({
          ...current,
          sofiaServerStatus: "disconnected",
          sofiaServerCapabilities: null,
          sofiaServerCheckedAt: Date.now(),
        }));
        return false;
      }

      const result = await checkSofiaServer(url, auth.token, auth.hostToken);
      mutateState((current) => ({
        ...current,
        sofiaServerStatus: result.status,
        sofiaServerCapabilities: result.capabilities,
        sofiaServerCheckedAt: Date.now(),
      }));
      return result.status === "connected" || result.status === "limited";
    } finally {
      setStateField("sofiaReconnectBusy", false);
    }
  };

  async function ensureLocalSofiaServerClient(): Promise<SofiaServerClient | null> {
    let hostInfo = state.sofiaServerHostInfo;
    if (hostInfo?.baseUrl?.trim() && hostInfo.clientToken?.trim()) {
      const existing = createSofiaServerClient({
        baseUrl: hostInfo.baseUrl.trim(),
        token: hostInfo.clientToken.trim(),
        hostToken: hostInfo.hostToken?.trim() || undefined,
      });
      try {
        await existing.health();
        if (options.startupPreference() !== "server") {
          await reconnectSofiaServer();
        }
        return existing;
      } catch {
        // Fall through to a local restart.
      }
    }

    if (!isDesktopRuntime()) return null;

    try {
      hostInfo = await sofiaServerRestart({
        remoteAccessEnabled: state.sofiaServerSettings.remoteAccessEnabled === true,
      }) as SofiaServerInfo;
      mutateState((current) => ({ ...current, sofiaServerHostInfo: hostInfo }));
    } catch {
      return null;
    }

    const baseUrl = hostInfo?.baseUrl?.trim() ?? "";
    const token = hostInfo?.clientToken?.trim() ?? "";
    const hostToken = hostInfo?.hostToken?.trim() ?? "";
    if (!baseUrl || !token) return null;

    if (options.startupPreference() !== "server") {
      await reconnectSofiaServer();
    }

    return createSofiaServerClient({
      baseUrl,
      token,
      hostToken: hostToken || undefined,
    });
  }

  const saveShareRemoteAccess = async (enabled: boolean) => {
    if (state.shareRemoteAccessBusy) return;
    const previous = state.sofiaServerSettings;
    const next: SofiaServerSettings = {
      ...previous,
      remoteAccessEnabled: enabled,
    };

    mutateState((current) => ({
      ...current,
      shareRemoteAccessBusy: true,
      shareRemoteAccessError: null,
    }));
    updateSofiaServerSettings(next);

    try {
      if (isDesktopRuntime() && options.selectedWorkspaceDisplay().workspaceType === "local") {
        const restarted = await options.restartLocalServer();
        if (!restarted) {
          throw new Error(t("app.error_restart_local_worker"));
        }
        await reconnectSofiaServer();
      }
    } catch (error) {
      updateSofiaServerSettings(previous);
      mutateState((current) => ({
        ...current,
        shareRemoteAccessError:
          error instanceof Error
            ? error.message
            : t("app.error_remote_access"),
      }));
      return;
    } finally {
      setStateField("shareRemoteAccessBusy", false);
    }
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
    setSofiaServerSettings,
    updateSofiaServerSettings,
    resetSofiaServerSettings,
    saveShareRemoteAccess,
    checkSofiaServer,
    testSofiaServerConnection,
    reconnectSofiaServer,
    ensureLocalSofiaServerClient,
  };
}

export function useSofiaServerStoreSnapshot(store: SofiaServerStore) {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
