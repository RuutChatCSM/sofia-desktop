import { existsSync } from "node:fs";
import { importNodeSqlite, runtimeDbPath } from "./runtime-db.js";
import type { ServerConfig } from "./types.js";
import { createWorkspaceKvStore, isRecord } from "./workspace-kv-store.js";

export { runtimeDbPath, runtimeStorageDir } from "./runtime-db.js";

export type RuntimeWorkspaceEngineConfig = {
  default_agent?: string;
  plugin?: string[];
  disabled_providers?: string[];
  mcp?: Record<string, Record<string, unknown>>;
  permission?: {
    external_directory?: Record<string, unknown>;
  };
  provider?: Record<string, unknown>;
};

export const ENGINE_GLOBAL_RUNTIME_CONFIG_ID = "__sofia_engine_global__";

export function isEngineGlobalRuntimeConfigId(workspaceId: string): boolean {
  return workspaceId === ENGINE_GLOBAL_RUNTIME_CONFIG_ID;
}

function normalizeRuntimeWorkspaceEngineConfig(value: unknown): RuntimeWorkspaceEngineConfig {
  if (!isRecord(value)) return {};
  const defaultAgent = typeof value.default_agent === "string" ? value.default_agent : undefined;
  const plugin = Array.isArray(value.plugin) ? value.plugin.filter((item) => typeof item === "string") : undefined;
  const disabledProviders = Array.isArray(value.disabled_providers)
    ? value.disabled_providers.filter((item) => typeof item === "string")
    : undefined;
  const mcp = isRecord(value.mcp) ? value.mcp as Record<string, Record<string, unknown>> : undefined;
  const permission = isRecord(value.permission) ? value.permission : undefined;
  const externalDirectory = permission && isRecord(permission.external_directory) ? permission.external_directory : undefined;
  const provider = isRecord(value.provider) ? value.provider : undefined;
  return {
    ...(defaultAgent ? { default_agent: defaultAgent } : {}),
    ...(plugin ? { plugin } : {}),
    ...(disabledProviders ? { disabled_providers: disabledProviders } : {}),
    ...(mcp ? { mcp } : {}),
    ...(externalDirectory ? { permission: { external_directory: externalDirectory } } : {}),
    ...(provider ? { provider } : {}),
  };
}

function parseRuntimeWorkspaceEngineConfig(configJson: string): RuntimeWorkspaceEngineConfig {
  try {
    return normalizeRuntimeWorkspaceEngineConfig(JSON.parse(configJson));
  } catch {
    return {};
  }
}

const runtimeWorkspaceEngineConfigStore = createWorkspaceKvStore<RuntimeWorkspaceEngineConfig>({
  tableName: "runtime_engine_configs",
  valueColumn: "config_json",
  parse: parseRuntimeWorkspaceEngineConfig,
  serialize: (value) => JSON.stringify(value),
});

export type RuntimeWorkspaceEngineConfigWriteListener = (config: ServerConfig, workspaceId: string) => void;

const writeListeners = new Set<RuntimeWorkspaceEngineConfigWriteListener>();

/**
 * Observe runtime config writes. Used to keep derived state (e.g. the
 * engine-visible runtime config file) in sync with the DB. Returns an
 * unsubscribe function. Listeners must not throw.
 */
export function onRuntimeWorkspaceEngineConfigWrite(listener: RuntimeWorkspaceEngineConfigWriteListener): () => void {
  writeListeners.add(listener);
  return () => writeListeners.delete(listener);
}

export function runtimePluginList(config: RuntimeWorkspaceEngineConfig): string[] {
  return Array.isArray(config.plugin) ? config.plugin.filter((item) => typeof item === "string") : [];
}

export function runtimeDisabledProviderList(config: RuntimeWorkspaceEngineConfig): string[] {
  return Array.isArray(config.disabled_providers)
    ? config.disabled_providers.filter((item) => typeof item === "string")
    : [];
}

export function runtimeMcpMap(config: RuntimeWorkspaceEngineConfig): Record<string, Record<string, unknown>> {
  return isRecord(config.mcp) ? config.mcp as Record<string, Record<string, unknown>> : {};
}

export function runtimeProviderMap(config: RuntimeWorkspaceEngineConfig): Record<string, Record<string, unknown>> {
  const provider: Record<string, Record<string, unknown>> = {};
  if (!isRecord(config.provider)) return provider;
  for (const [providerId, value] of Object.entries(config.provider)) {
    if (isRecord(value)) provider[providerId] = value;
  }
  return provider;
}

/** Narrow server-owned read port for consumers that need one runtime MCP endpoint. */
export async function readRuntimeMcpConfig(
  config: ServerConfig,
  workspaceId: string,
  name: string,
): Promise<Record<string, unknown> | null> {
  return runtimeMcpMap(await readRuntimeWorkspaceEngineConfig(config, workspaceId))[name] ?? null;
}

export function runtimeExternalDirectory(config: RuntimeWorkspaceEngineConfig): Record<string, unknown> {
  const permission = isRecord(config.permission) ? config.permission : null;
  const externalDirectory = permission && isRecord(permission.external_directory) ? permission.external_directory : null;
  return externalDirectory ?? {};
}

/**
 * Per-provider merge for runtime config patches: record values upsert the
 * provider, explicit `null` deletes it (so clients can remove runtime-managed
 * providers, e.g. cloud imports, without racing a read-modify-write of the
 * whole map). Returns undefined when the resulting map is empty.
 */
export function mergeRuntimeProviderUpdate(
  current: unknown,
  update: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const next: Record<string, unknown> = { ...(isRecord(current) ? current : {}) };
  for (const [providerId, value] of Object.entries(update)) {
    if (value === null) {
      delete next[providerId];
    } else if (isRecord(value)) {
      next[providerId] = value;
    }
  }
  return Object.keys(next).length ? next : undefined;
}

export async function readRuntimeWorkspaceEngineConfig(config: ServerConfig, workspaceId: string): Promise<RuntimeWorkspaceEngineConfig> {
  return await runtimeWorkspaceEngineConfigStore.get(config, workspaceId) ?? {};
}

export async function readGlobalRuntimeWorkspaceEngineConfig(config: ServerConfig): Promise<RuntimeWorkspaceEngineConfig> {
  return await readRuntimeWorkspaceEngineConfig(config, ENGINE_GLOBAL_RUNTIME_CONFIG_ID);
}

export async function writeGlobalRuntimeWorkspaceEngineConfig(
  config: ServerConfig,
  updater: (current: RuntimeWorkspaceEngineConfig) => RuntimeWorkspaceEngineConfig,
): Promise<{ config: RuntimeWorkspaceEngineConfig; changed: boolean }> {
  return await writeRuntimeWorkspaceEngineConfig(config, ENGINE_GLOBAL_RUNTIME_CONFIG_ID, updater);
}

function uniqueStrings(items: string[]): string[] {
  return items.filter((item, index, list) => list.indexOf(item) === index);
}

function mergeRuntimeWorkspaceEngineConfigLayers(
  base: RuntimeWorkspaceEngineConfig,
  overlay: RuntimeWorkspaceEngineConfig,
): RuntimeWorkspaceEngineConfig {
  const plugin = uniqueStrings([
    ...runtimePluginList(base),
    ...runtimePluginList(overlay),
  ]);
  const disabledProviders = uniqueStrings([
    ...runtimeDisabledProviderList(base),
    ...runtimeDisabledProviderList(overlay),
  ]);
  const mcp = {
    ...runtimeMcpMap(base),
    ...runtimeMcpMap(overlay),
  };
  const basePermission = isRecord(base.permission) ? base.permission : {};
  const overlayPermission = isRecord(overlay.permission) ? overlay.permission : {};
  const externalDirectory = {
    ...runtimeExternalDirectory(base),
    ...runtimeExternalDirectory(overlay),
  };
  const permission = {
    ...basePermission,
    ...overlayPermission,
    ...(Object.keys(externalDirectory).length ? { external_directory: externalDirectory } : {}),
  };
  const provider = {
    ...runtimeProviderMap(base),
    ...runtimeProviderMap(overlay),
  };

  return normalizeRuntimeWorkspaceEngineConfig({
    ...(base.default_agent || overlay.default_agent ? { default_agent: overlay.default_agent ?? base.default_agent } : {}),
    ...(plugin.length ? { plugin } : {}),
    ...(disabledProviders.length ? { disabled_providers: disabledProviders } : {}),
    ...(Object.keys(mcp).length ? { mcp } : {}),
    ...(Object.keys(permission).length ? { permission } : {}),
    ...(Object.keys(provider).length ? { provider } : {}),
  });
}

export async function readEffectiveRuntimeWorkspaceEngineConfig(
  config: ServerConfig,
  workspaceId: string,
): Promise<RuntimeWorkspaceEngineConfig> {
  if (isEngineGlobalRuntimeConfigId(workspaceId)) {
    return await readRuntimeWorkspaceEngineConfig(config, workspaceId);
  }
  const [globalRuntime, workspaceRuntime] = await Promise.all([
    readGlobalRuntimeWorkspaceEngineConfig(config),
    readRuntimeWorkspaceEngineConfig(config, workspaceId),
  ]);
  return mergeRuntimeWorkspaceEngineConfigLayers(globalRuntime, workspaceRuntime);
}

export type RuntimeWorkspaceEngineConfigInspection = {
  status: "available" | "database-missing" | "row-missing" | "table-missing" | "unreadable" | "invalid-row" | "remote-workspace";
  config: RuntimeWorkspaceEngineConfig;
};

export type RuntimeWorkspaceEngineConfigInspectionOptions = {
  maxBytes?: number;
  signal?: AbortSignal;
};

const RUNTIME_SOFIA_ENGINE_CONFIG_INSPECTION_MAX_BYTES = 1024 * 1024;
const RUNTIME_SOFIA_ENGINE_CONFIG_INSPECTION_MAX_DEPTH = 32;
const RUNTIME_SOFIA_ENGINE_CONFIG_INSPECTION_MAX_NODES = 20_000;

function inspectionMaxBytes(value: number | undefined): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : RUNTIME_SOFIA_ENGINE_CONFIG_INSPECTION_MAX_BYTES;
}

function hasBoundedRuntimeConfigStructure(value: unknown): boolean {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  const visited = new Set<object>();
  let nodes = 0;

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    nodes += 1;
    if (nodes > RUNTIME_SOFIA_ENGINE_CONFIG_INSPECTION_MAX_NODES) return false;
    if (current.depth > RUNTIME_SOFIA_ENGINE_CONFIG_INSPECTION_MAX_DEPTH) return false;
    if (typeof current.value !== "object" || current.value === null) continue;
    if (visited.has(current.value)) return false;
    visited.add(current.value);

    const children = Array.isArray(current.value)
      ? current.value
      : Object.values(current.value);
    for (const child of children) {
      stack.push({ value: child, depth: current.depth + 1 });
    }
  }
  return true;
}

function inspectRuntimeConfigRow(
  row: unknown,
  maxBytes: number,
): RuntimeWorkspaceEngineConfigInspection {
  if (!isRecord(row)) return { status: "row-missing", config: {} };
  if (
    typeof row.configBytes !== "number"
    || !Number.isSafeInteger(row.configBytes)
    || row.configBytes < 0
  ) {
    return { status: "invalid-row", config: {} };
  }
  if (row.configBytes > maxBytes || typeof row.configJson !== "string") {
    return { status: "invalid-row", config: {} };
  }

  try {
    const parsed = JSON.parse(row.configJson) as unknown;
    if (!isRecord(parsed)) return { status: "invalid-row", config: {} };
    if (!hasBoundedRuntimeConfigStructure(parsed)) {
      return { status: "invalid-row", config: {} };
    }
    if (Object.hasOwn(parsed, "mcp")) {
      if (!isRecord(parsed.mcp) || Object.values(parsed.mcp).some((entry) => !isRecord(entry))) {
        return { status: "invalid-row", config: {} };
      }
    }
    return { status: "available", config: normalizeRuntimeWorkspaceEngineConfig(parsed) };
  } catch {
    return { status: "invalid-row", config: {} };
  }
}

function classifyReadonlySqliteFailure(error: unknown): "table-missing" | "unreadable" {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return message.includes("no such table") ? "table-missing" : "unreadable";
}

/**
 * Inspect one runtime config row without creating the state directory, SQLite
 * file, or schema. Diagnostics use this path so a read on a fresh install is
 * genuinely side-effect free.
 */
export async function inspectRuntimeWorkspaceEngineConfigState(
  config: ServerConfig,
  workspaceId: string,
  options?: RuntimeWorkspaceEngineConfigInspectionOptions,
): Promise<RuntimeWorkspaceEngineConfigInspection> {
  options?.signal?.throwIfAborted();
  const path = runtimeDbPath(config);
  if (!existsSync(path)) return { status: "database-missing", config: {} };
  const maxBytes = inspectionMaxBytes(options?.maxBytes);

  if (typeof process.versions.bun === "string") {
    const { Database } = await import("bun:sqlite");
    options?.signal?.throwIfAborted();
    try {
      const sqlite = new Database(path, { readonly: true, create: false });
      try {
        const row = sqlite.query(`
          SELECT
            length(CAST(config_json AS BLOB)) AS configBytes,
            CASE
              WHEN length(CAST(config_json AS BLOB)) <= ? THEN config_json
              ELSE NULL
            END AS configJson
          FROM runtime_engine_configs
          WHERE workspace_id = ?
        `).get(maxBytes, workspaceId);
        options?.signal?.throwIfAborted();
        return inspectRuntimeConfigRow(row, maxBytes);
      } finally {
        sqlite.close();
      }
    } catch (error) {
      options?.signal?.throwIfAborted();
      return { status: classifyReadonlySqliteFailure(error), config: {} };
    }
  }

  const { DatabaseSync } = await importNodeSqlite();
  options?.signal?.throwIfAborted();
  try {
    const sqlite = new DatabaseSync(path, { readOnly: true });
    try {
      const row = sqlite.prepare(`
          SELECT
            length(CAST(config_json AS BLOB)) AS configBytes,
            CASE
              WHEN length(CAST(config_json AS BLOB)) <= ? THEN config_json
              ELSE NULL
            END AS configJson
          FROM runtime_engine_configs
          WHERE workspace_id = ?
      `).get(maxBytes, workspaceId);
      options?.signal?.throwIfAborted();
      return inspectRuntimeConfigRow(row, maxBytes);
    } finally {
      sqlite.close();
    }
  } catch (error) {
    options?.signal?.throwIfAborted();
    return { status: classifyReadonlySqliteFailure(error), config: {} };
  }
}

export async function inspectRuntimeWorkspaceEngineConfig(
  config: ServerConfig,
  workspaceId: string,
  options?: RuntimeWorkspaceEngineConfigInspectionOptions,
): Promise<RuntimeWorkspaceEngineConfig> {
  return (await inspectRuntimeWorkspaceEngineConfigState(config, workspaceId, options)).config;
}

export async function writeRuntimeWorkspaceEngineConfig(
  config: ServerConfig,
  workspaceId: string,
  updater: (current: RuntimeWorkspaceEngineConfig) => RuntimeWorkspaceEngineConfig,
): Promise<{ config: RuntimeWorkspaceEngineConfig; changed: boolean }> {
  const row = await runtimeWorkspaceEngineConfigStore.getRow(config, workspaceId);
  const current = row ? row.value : {};
  const next = normalizeRuntimeWorkspaceEngineConfig(updater(current));
  const now = Date.now();
  const configJson = runtimeWorkspaceEngineConfigStore.serialize(next);
  if (row?.valueJson === configJson) {
    return { config: next, changed: false };
  }
  await runtimeWorkspaceEngineConfigStore.setSerialized(config, workspaceId, configJson, now);
  for (const listener of writeListeners) listener(config, workspaceId);
  return { config: next, changed: true };
}

export function mergeWorkspaceEngineConfigs(
  persisted: Record<string, unknown>,
  runtime: RuntimeWorkspaceEngineConfig,
): Record<string, unknown> {
  const persistedPermission = isRecord(persisted.permission) ? persisted.permission : {};
  const persistedExternalDirectory = isRecord(persistedPermission.external_directory)
    ? persistedPermission.external_directory
    : {};
  const runtimeProvider = runtimeProviderMap(runtime);
  return {
    ...persisted,
    plugin: [
      ...(Array.isArray(persisted.plugin) ? persisted.plugin.filter((item) => typeof item === "string") : []),
      ...runtimePluginList(runtime),
    ],
    disabled_providers: [
      ...(Array.isArray(persisted.disabled_providers) ? persisted.disabled_providers.filter((item) => typeof item === "string") : []),
      ...runtimeDisabledProviderList(runtime),
    ].filter((item, index, list) => list.indexOf(item) === index),
    mcp: {
      ...(isRecord(persisted.mcp) ? persisted.mcp : {}),
      ...runtimeMcpMap(runtime),
    },
    permission: {
      ...persistedPermission,
      external_directory: {
        ...persistedExternalDirectory,
        ...runtimeExternalDirectory(runtime),
      },
    },
    ...(Object.keys(runtimeProvider).length ? { provider: { ...(isRecord(persisted.provider) ? persisted.provider : {}), ...runtimeProvider } } : {}),
    ...(runtime.default_agent ? { default_agent: runtime.default_agent } : {}),
  };
}
