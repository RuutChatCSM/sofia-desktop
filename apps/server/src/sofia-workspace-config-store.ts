import type { ServerConfig } from "./types.js";
import { createWorkspaceKvStore, isRecord } from "./workspace-kv-store.js";

function normalizeSofiaWorkspaceConfig(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function parseSofiaWorkspaceConfig(configJson: string): Record<string, unknown> {
  try {
    return normalizeSofiaWorkspaceConfig(JSON.parse(configJson));
  } catch {
    return {};
  }
}

const sofiaWorkspaceConfigStore = createWorkspaceKvStore<Record<string, unknown>>({
  tableName: "sofia_workspace_configs",
  valueColumn: "config_json",
  parse: parseSofiaWorkspaceConfig,
  serialize: (value) => JSON.stringify(value),
});

export async function readSofiaWorkspaceConfig(config: ServerConfig, workspaceId: string): Promise<Record<string, unknown>> {
  return await sofiaWorkspaceConfigStore.get(config, workspaceId) ?? {};
}

export async function writeSofiaWorkspaceConfig(
  config: ServerConfig,
  workspaceId: string,
  updater: (current: Record<string, unknown>) => Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const next = normalizeSofiaWorkspaceConfig(updater(await readSofiaWorkspaceConfig(config, workspaceId)));
  await sofiaWorkspaceConfigStore.set(config, workspaceId, next);
  return next;
}

export async function hasSofiaWorkspaceConfig(
  config: ServerConfig,
  workspaceId: string,
): Promise<boolean> {
  return sofiaWorkspaceConfigStore.has(config, workspaceId);
}

/**
 * Seed the DB-backed sofia config for a workspace if no row exists yet.
 * Used at workspace creation and as the migrate-on-read landing spot for
 * legacy `.sofia/sofia.json` files. No-op when a row is already present,
 * so it never clobbers live provisioning state.
 */
export async function seedSofiaWorkspaceConfigIfEmpty(
  config: ServerConfig,
  workspaceId: string,
  seed: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (await hasSofiaWorkspaceConfig(config, workspaceId)) {
    return readSofiaWorkspaceConfig(config, workspaceId);
  }
  return writeSofiaWorkspaceConfig(config, workspaceId, () => seed);
}

export function mergeSofiaWorkspaceConfigs(
  legacy: Record<string, unknown>,
  stored: Record<string, unknown>,
): Record<string, unknown> {
  return { ...legacy, ...stored };
}
