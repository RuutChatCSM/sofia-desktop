// Codex session registry: owns one CodexSessionManager per workspace and
// resolves the codex binary. The desktop runtime injects the resolved binary
// via setCodexBinaryForConfig (or falls back to `codex` on PATH). Additive to
// the engine engine lifecycle.
import { writeFile, mkdir, readFile, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

import { readCodexAuthStore } from "./codex-auth-store.js";
import { codexConfigTomlFromRuntime } from "./codex-config.js";
import { codexConfigTomlFromEngineConfig, readCodexEngineConfig } from "./codex-providers.js";
import {
  codexMcpServersToml,
  codexRuntimeSkillsFor,
  defaultCodexRuntimeMcpServers,
} from "./codex-runtime-mcp.js";
import { readCodexAccessMode, sandboxModeFor } from "./codex-access.js";
import { createCodexSessionManager, type CodexEngineHandle, type CodexSessionManager } from "./codex-sessions.js";
import { ENGINE_GLOBAL_RUNTIME_CONFIG_ID, readRuntimeWorkspaceEngineConfig } from "./runtime-engine-config-store.js";
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
 * Sofia-managed home (never the user's `~/.codex`) so the app fully controls
 * its config.toml/auth/sessions without clobbering the user's real codex setup
 * or picking up its ChatGPT/OpenAI config. `SOFIA_CODEX_HOME` (desktop pin),
 * then `CODEX_HOME`, then a stable per-profile dir.
 */
function codexHomeFor(cwd: string): string {
  const pinned = process.env.SOFIA_HOME?.trim() || process.env.SOFIA_CODEX_HOME?.trim();
  if (pinned) return pinned;
  if (process.env.CODEX_HOME?.trim()) return process.env.CODEX_HOME.trim();
  // Sofia-managed default: ~/.config/sofia/sofia (shared across dev/prod,
  // stable under the real home, distinct from ~/.codex).
  const home = process.env.HOME?.trim() || homedir();
  if (home) return join(home, ".sofia");
  return join(cwd, ".codex");
}

export async function codexEngineHandleForConfig(config: ServerConfig, workspaceId: string): Promise<CodexEngineHandle | null> {
  const resolver = codexBinaryForConfig(config);
  if (!resolver) return null;
  const cwd = workspaceCwd(config, workspaceId);
  const home = codexHomeFor(cwd);
  await prepareCodexConfigToml(config, workspaceId, home);
  await prepareSofiaAuthInHome(home);
  // thread/start and thread/resume reload config from disk. Keep managers alive:
  // replacing them drops active turns, fresh threads and SSE subscriptions.
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
    const store: Record<string, string> = { ...(await readCodexAuthStore()) };
    // The engine also searches `~/.sofia` and `~/.config/sofia` for keys, but
    // that fallback resolves `~` via $HOME. Copy any keys found there into the
    // authoritative `$CODEX_HOME/sofia-auth.json` so credentials resolve even
    // when the engine is spawned without HOME.
    const home = process.env.REAL_HOME?.trim() || process.env.HOME?.trim() || homedir();
    for (const legacy of [join(home, ".sofia"), join(home, ".config", "sofia")]) {
      try {
        const parsed: unknown = JSON.parse(await readFile(join(legacy, "sofia-auth.json"), "utf8"));
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
        for (const [key, value] of Object.entries(parsed)) {
          if (typeof value === "string" && value.trim() && !store[key]) store[key] = value.trim();
        }
      } catch {
        // No credential store at this legacy location.
      }
    }
    await mkdir(codexHome, { recursive: true });
    await writeEngineFile(join(codexHome, "sofia-auth.json"), `${JSON.stringify(store, null, 2)}\n`);
  } catch (error) {
    throw new Error("Unable to synchronize Sofia provider credentials", { cause: error });
  }
}

/** Atomically replace engine files so concurrent requests never read a truncated file. */
async function writeEngineFile(path: string, content: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Materialize the provider catalog and runtime capabilities before engine requests. */
export async function prepareCodexConfigToml(
  config: ServerConfig,
  workspaceId: string,
  codexHome: string,
): Promise<void> {
  try {
    await mkdir(codexHome, { recursive: true });
    let toml = "";
    const engineConfig = await readCodexEngineConfig();
    if (engineConfig.providers.length > 0) {
      toml = codexConfigTomlFromEngineConfig(engineConfig);
    } else {
      const globalConfig = await readRuntimeWorkspaceEngineConfig(config, ENGINE_GLOBAL_RUNTIME_CONFIG_ID);
      const workspaceConfig = await readRuntimeWorkspaceEngineConfig(config, workspaceId);
      const merged = {
        provider: { ...(globalConfig.provider ?? {}), ...(workspaceConfig.provider ?? {}) },
      };
      toml = codexConfigTomlFromRuntime(merged);
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
    await writeEngineFile(join(codexHome, "config.toml"), toml);
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
    const enableLegacyImport = Boolean(handle) && process.env.SOFIA_CODEX_IMPORT_LEGACY === "1";
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
