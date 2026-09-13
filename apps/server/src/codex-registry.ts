// Codex session registry: owns one CodexSessionManager per workspace and
// resolves the codex binary. The desktop runtime injects the resolved binary
// via setCodexBinaryForConfig (or falls back to `codex` on PATH). Additive to
// the opencode engine lifecycle.
import { writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { readCodexAuthStore } from "./codex-auth-store.js";
import { codexConfigTomlFromRuntime } from "./codex-config.js";
import { codexConfigTomlFromEngineConfig, readCodexEngineConfig } from "./codex-engine-config.js";
import {
  codexMcpServersToml,
  codexRuntimeSkillsFor,
  defaultCodexRuntimeMcpServers,
} from "./codex-runtime-mcp.js";
import { readCodexAccessMode, sandboxModeFor } from "./codex-access.js";
import { createCodexSessionManager, type CodexEngineHandle, type CodexSessionManager } from "./codex-sessions.js";
import { ENGINE_GLOBAL_RUNTIME_CONFIG_ID, readRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import type { ServerConfig } from "./types.js";
import { ApiError } from "./errors.js";

export type CodexBinaryResolver = {
  path: string;
  source: "custom" | "bundled" | "path" | "known-location";
} | null;

const perConfigBinary = new Map<ServerConfig, CodexBinaryResolver>();
const perConfigManagers = new Map<ServerConfig, Map<string, CodexSessionManager>>();

export function hasRunningCodexSessions(config: ServerConfig): boolean {
  return [...(perConfigManagers.get(config)?.values() ?? [])]
    .some((manager) => manager.listSessions().some((session) => session.status === "running"));
}

/** Allow the desktop runtime to tell us exactly which codex binary to use. */
export function setCodexBinaryForConfig(config: ServerConfig, resolver: CodexBinaryResolver): void {
  if (resolver) {
    perConfigBinary.set(config, resolver);
  } else {
    perConfigBinary.delete(config);
  }
}

export function codexBinaryForConfig(config: ServerConfig): CodexBinaryResolver {
  return perConfigBinary.get(config) ?? null;
}

function workspaceCwd(config: ServerConfig, workspaceId: string): string {
  const workspace = config.workspaces?.find((entry) => entry.id === workspaceId);
  if (!workspace) throw new ApiError(404, "not_found", "Unknown Sofia workspace");
  return workspace.path;
}

/**
 * Resolve the codex engine's home dir. The bundled Sofia engine uses a DEDICATED
 * OpenWork-managed home (never the user's `~/.codex`) so the app fully controls
 * its config.toml/auth/sessions without clobbering the user's real codex setup
 * or picking up its ChatGPT/OpenAI config. `OPENWORK_CODEX_HOME` (desktop pin),
 * then `CODEX_HOME`, then a stable per-profile dir.
 */
function codexHomeFor(cwd: string): string {
  const pinned = process.env.OPENWORK_CODEX_HOME?.trim();
  if (pinned) return pinned;
  if (process.env.CODEX_HOME?.trim()) return process.env.CODEX_HOME.trim();
  // OpenWork-managed default: ~/.config/openwork/sofia (shared across dev/prod,
  // stable under the real home, distinct from ~/.codex).
  const home = process.env.HOME?.trim() || homedir();
  if (home) return join(home, ".config", "openwork", "sofia");
  return join(cwd, ".codex");
}

export async function codexEngineHandleForConfig(config: ServerConfig, workspaceId: string): Promise<CodexEngineHandle | null> {
  const resolver = codexBinaryForConfig(config);
  if (!resolver) return null;
  const cwd = workspaceCwd(config, workspaceId);
  const home = codexHomeFor(cwd);
  await prepareCodexConfigToml(config, workspaceId, home);
  await prepareSofiaAuthInHome(home);
  return { bin: resolver.path, cwd, codexHome: home };
}

/**
 * Materialize the app's provider credentials into `CODEX_HOME/sofia-auth.json`
 * so the bundled engine reads them natively (the fork resolves `env_key` from
 * this file — see ModelProviderInfo::api_key). The engine prefers `$CODEX_HOME`
 * first, which the child always has set, so writing here is authoritative.
 * Best-effort: a missing store just means the engine falls back to built-in
 * auth.
 */
export async function prepareSofiaAuthInHome(codexHome: string): Promise<void> {
  try {
    const store = await readCodexAuthStore();
    await mkdir(codexHome, { recursive: true });
    await writeFile(join(codexHome, "sofia-auth.json"), `${JSON.stringify(store, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  } catch (error) {
    throw new Error("Unable to synchronize Sofia provider credentials", { cause: error });
  }
}

/**
 * Write `config.toml` into the codex home dir so the bundled codex engine sees
 * the same providers/models the opencode engine does (the UI model picker data).
 * Global + workspace provider maps are merged, workspace winning, exactly like
 * the opencode runtime config merge. The app-owned `codexengine.json` wins when
 * present (it is what the app model configuration writes). Best-effort:
 * failures never block the codex engine from starting.
 */
export async function prepareCodexConfigToml(
  config: ServerConfig,
  workspaceId: string,
  codexHome: string,
): Promise<void> {
  try {
    await mkdir(codexHome, { recursive: true });
    const authStore = await readCodexAuthStore();
    let toml = "";
    const engineConfig = await readCodexEngineConfig();
    if (engineConfig.providers.length > 0) {
      toml = codexConfigTomlFromEngineConfig(engineConfig, authStore);
    } else {
      const globalConfig = await readRuntimeOpencodeConfig(config, ENGINE_GLOBAL_RUNTIME_CONFIG_ID);
      const workspaceConfig = await readRuntimeOpencodeConfig(config, workspaceId);
      const merged = {
        provider: { ...(globalConfig.provider ?? {}), ...(workspaceConfig.provider ?? {}) },
      };
      toml = codexConfigTomlFromRuntime(merged, authStore);
    }
    // Runtime surfaces (computer-use, browser): MCP servers + the SKILL.md docs
    // that teach the agent when/how to use them. Additive and best-effort, and
    // always applied even when no provider is configured yet.
    const runtimeServers = defaultCodexRuntimeMcpServers();
    const runtimeToml = codexMcpServersToml(runtimeServers);
    if (runtimeToml) toml += `${toml ? "\n" : ""}${runtimeToml}`;
    // Codex's sandbox defaults to read-only, so a project is only editable when
    // we opt in. The access mode (the composer toggle) maps to codex's
    // `sandbox_mode`: "ask"/"approve" write within the workspace (with network),
    // "full" writes anywhere. These are TOP-LEVEL config keys, so they must be
    // inserted BEFORE any `[table]` (appending after `[mcp_servers.*]` would make
    // codex treat them as fields of that table and refuse to start).
    const accessMode = readCodexAccessMode(codexHome);
    const sandboxMode = sandboxModeFor(accessMode);
    const sandboxBlock =
      sandboxMode === "workspace-write"
        ? `sandbox_mode = "workspace-write"\n[sandbox_workspace_write]\nnetwork_access = true\n`
        : `sandbox_mode = ${JSON.stringify(sandboxMode)}\n`;
    if (sandboxBlock) toml = insertTomlTopLevelBlock(toml, sandboxBlock);
    if (!toml) return;
    await writeFile(join(codexHome, "config.toml"), toml, "utf8");
    await codexRuntimeSkillsFor(codexHome);
  } catch (error) {
    throw new Error("Unable to prepare Sofia engine configuration", { cause: error });
  }
}

/** Insert a block of top-level settings (and their tables) before the first
 * `[table]` header, so they stay top-level instead of becoming the previous
 * table's fields. Appends when there is no table header. */
function insertTomlTopLevelBlock(toml: string, block: string): string {
  const rest = toml.trim();
  if (!rest) return block;
  const tableIndex = rest.search(/^\[/m);
  if (tableIndex === -1) return `${rest}\n${block}`;
  const before = rest.slice(0, tableIndex);
  const after = rest.slice(tableIndex);
  return `${before}${block}${after}`;
}

export async function getOrCreateCodexSessionManager(config: ServerConfig, workspaceId: string): Promise<CodexSessionManager> {
  const handle = await codexEngineHandleForConfig(config, workspaceId);
  if (!handle) {
    throw new Error("codex binary is not configured for this workspace");
  }
  let perWorkspace = perConfigManagers.get(config);
  if (!perWorkspace) {
    perWorkspace = new Map();
    perConfigManagers.set(config, perWorkspace);
  }
  let manager = perWorkspace.get(workspaceId);
  if (!manager) {
    // Legacy ~/.codex import only in the desktop runtime (bundled binary
    // present), never in isolated tests.
    const enableLegacyImport = Boolean(handle) && process.env.OPENWORK_CODEX_IMPORT_LEGACY === "1";
    console.log("[codex-registry] enableLegacyImport =", enableLegacyImport, "env =", process.env.OPENWORK_CODEX_IMPORT_LEGACY);
    manager = createCodexSessionManager(handle, workspaceId, enableLegacyImport);
    perWorkspace.set(workspaceId, manager);
  }
  return manager;
}

export async function closeCodexManagersForConfig(config: ServerConfig): Promise<void> {
  const perWorkspace = perConfigManagers.get(config);
  if (!perWorkspace) return;
  await Promise.all([...perWorkspace.values()].map((manager) => manager.close()));
  perWorkspace.clear();
  perConfigBinary.delete(config);
}
