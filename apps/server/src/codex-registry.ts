// Codex session registry: owns one CodexSessionManager per workspace and
// resolves the codex binary. The desktop runtime injects the resolved binary
// via setCodexBinaryForConfig (or falls back to `codex` on PATH). Additive to
// the engine engine lifecycle.
import { writeFile, mkdir, readFile, rename, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { readCodexAuthStore } from "./codex-auth-store.js";
import { applyEngineCapabilitiesToml, codexConfigTomlFromRuntime } from "./codex-config.js";
import {
  CODEX_MODEL_CATALOG_FILE,
  codexCatalogModelsFromProviders,
  codexCatalogModelsFromRuntimeProviderMap,
  mergeCodexCatalogModels,
  writeCodexModelCatalog,
} from "./codex-model-catalog.js";
import { codexConfigTomlFromEngineConfig, readCodexEngineConfig } from "./codex-providers.js";
import { applyLocalMemoryToml } from "./codex-memory-config.js";
import { pickDefaultCodexProvider } from "./codex-config.js";
import { sharedCodexSkillRoots } from "./codex-skill-roots.js";
import {
  codexDirectToolNamespacesToml,
  codexMcpServersToml,
  codexRuntimeSkillsFor,
  configuredCodexMcpServers,
} from "./codex-runtime-mcp.js";
import { readCodexAccessMode, sandboxModeFor } from "./codex-access.js";
import { createCodexSessionManager, type CodexEngineHandle, type CodexSessionManager } from "./codex-sessions.js";
import {
  readEffectiveRuntimeWorkspaceEngineConfig,
  runtimeEngineFeatureOverrides,
} from "./runtime-engine-config-store.js";
import type { ServerConfig } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
import { ApiError } from "./errors.js";

export type CodexBinaryResolver = {
  path: string;
  source: "custom" | "bundled" | "path" | "known-location";
} | null;

/**
 * The engine's remote-control pairing is the ChatGPT-backed "run this machine
 * from the web" transport. This app authenticates with provider API keys, which
 * pairing explicitly refuses ("remote control requires ChatGPT authentication;
 * API key auth is not supported"), and while the preference is unresolved the
 * engine re-logs each attempt — 160k rows and a 277 MB log DB over two days.
 *
 * The engine ships the supported switch, so use it rather than a config field
 * (an unknown field makes `--strict-config` refuse to start at all). Best-effort
 * and once per process: a failure here must never stop the engine from running.
 * `enable-remote-control` is the inverse if a Sofia-hosted remote surface wants
 * it later.
 */
let remoteControlDisabled: Promise<void> | null = null;
function ensureRemoteControlDisabled(bin: string): Promise<void> {
  remoteControlDisabled ??= (async () => {
    try {
      await promisify(execFile)(
        bin,
        ["app-server", "daemon", "disable-remote-control"],
        { timeout: 5_000 },
      );
    } catch {
      // Older engines have no such subcommand, and a missing daemon is fine.
    }
  })();
  return remoteControlDisabled;
}

const perConfigBinary = new Map<ServerConfig, CodexBinaryResolver>();

/**
 * One engine per (binary, engine home, cwd, workspace) — *not* per ServerConfig
 * instance. The embedded server resolves a fresh config object on every start,
 * so keying by object identity stranded the previous engine as an orphan child
 * (three `sofia app-server` processes were observed for one app) while a second
 * one was spawned for the same workspace. Those orphans keep a dead broker URL
 * and a second view of the session, which is what made browser calls fail
 * intermittently and sessions appear to fight each other.
 */
const managersByKey = new Map<string, CodexSessionManager>();
const managerKeysByConfig = new Map<ServerConfig, Set<string>>();

function codexManagerKey(handle: CodexEngineHandle, workspaceId: string): string {
  return [handle.bin, handle.codexHome ?? "", handle.cwd, workspaceId].join("\u0000");
}

function managersForConfig(config: ServerConfig): CodexSessionManager[] {
  const keys = managerKeysByConfig.get(config);
  if (!keys) return [];
  return [...keys].map((key) => managersByKey.get(key)).filter((manager): manager is CodexSessionManager => Boolean(manager));
}

export function hasRunningCodexSessions(config: ServerConfig): boolean {
  return managersForConfig(config)
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
  const configFile = codexWorkspaceConfigFile(config, workspaceId);
  void ensureRemoteControlDisabled(resolver.path);
  await prepareCodexConfigToml(config, workspaceId, home, configFile);
  await prepareSofiaAuthInHome(home);
  // thread/start and thread/resume reload config from disk. Keep managers alive:
  // replacing them drops active turns, fresh threads and SSE subscriptions.
  const runtimeConfig = await readEffectiveRuntimeWorkspaceEngineConfig(config, workspaceId);
  const skillRoots = sharedCodexSkillRoots(runtimeConfig, process.env.REAL_HOME?.trim() || homedir());
  return { bin: resolver.path, cwd, codexHome: home, skillRoots, env: { SOFIA_APP_CONFIG_FILE: configFile } };
}

/**
 * The engine config a workspace runs with. Each workspace gets its own file so
 * one project's MCP servers, providers and selection never leak into another's,
 * and so writing them leaves the shared session home untouched.
 */
export function codexWorkspaceConfigFile(config: ServerConfig, workspaceId: string): string {
  const cwd = workspaceCwd(config, workspaceId);
  return join(codexHomeFor(cwd), "app-workspaces", createHash("sha256").update(cwd).digest("hex"), "config.toml");
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
  configFile = join(codexHome, "config.toml"),
): Promise<void> {
  try {
    await mkdir(codexHome, { recursive: true });
    let toml = "";
    const runtimeConfig = await readEffectiveRuntimeWorkspaceEngineConfig(config, workspaceId);
    // The selected provider/model live in this file (the engine's user config),
    // so read it back: otherwise every regeneration would reset the picker to
    // the first connected provider.
    const engineConfig = await readCodexEngineConfig({ tomlPath: configFile });
    if (engineConfig.providers.length > 0) {
      toml = codexConfigTomlFromEngineConfig(engineConfig);
    } else {
      toml = codexConfigTomlFromRuntime(runtimeConfig);
    }
    // Runtime surfaces (computer-use, browser): MCP servers + the SKILL.md docs
    // that teach the agent when/how to use them. Additive and best-effort, and
    // always applied even when no provider is configured yet.
    const runtimeServers = configuredCodexMcpServers(runtimeConfig.mcp ?? {});
    const runtimeToml = codexMcpServersToml(runtimeServers);
    if (runtimeToml) toml += `${toml ? "\n" : ""}${runtimeToml}`;
    // The engine defers MCP tools whenever the model supports `tool_search`, so
    // a registered server can still be missing from the agent's tool list. Pin
    // the runtime surfaces so the tools their SKILL.md docs name are callable.
    const directToolsToml = codexDirectToolNamespacesToml(runtimeServers.filter((server) => server.enabled !== false && ["computer-use", "node_repl"].includes(server.name)));
    if (directToolsToml) toml += `${toml ? "\n" : ""}${directToolsToml}`;
    // Codex's sandbox defaults to read-only, so a project is only editable when
    // we opt in. The access mode (the composer toggle) maps to codex's
    // `sandbox_mode`: "ask"/"approve" write within the workspace (with network),
    // "full" writes anywhere. These are TOP-LEVEL config keys, so they must be
    // inserted BEFORE any `[table]` (appending after `[mcp_servers.*]` would make
    // codex treat them as fields of that table and refuse to start).
    // Engine built-ins the desktop surfaces (todo panel, pending permissions,
    // subagents). Applied after regeneration so a hand-edited config.toml or a
    // provider change cannot drop them.
    toml = applyEngineCapabilitiesToml(toml, runtimeEngineFeatureOverrides(runtimeConfig));
    const memoryModel = engineConfig.model ?? pickDefaultCodexProvider(Object.fromEntries(Object.entries(runtimeConfig.provider ?? {}).filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1]))))?.model ?? null;
    toml = applyLocalMemoryToml(toml, runtimeConfig.memories, memoryModel);
    // Models the user connected that the engine's vendored catalog cannot know.
    // Without this the engine resolves them through its tool-blind fallback and
    // the agent silently loses `apply_patch` and the real context window.
    const catalogModels = mergeCodexCatalogModels(
      codexCatalogModelsFromProviders(engineConfig.providers),
      codexCatalogModelsFromRuntimeProviderMap(
        isRecord(runtimeConfig.provider) ? runtimeConfig.provider as Record<string, Record<string, unknown>> : {},
      ),
    );
    if (catalogModels.length > 0) {
      const catalogPath = join(dirname(configFile), CODEX_MODEL_CATALOG_FILE);
      await writeCodexModelCatalog(catalogPath, catalogModels);
      toml = insertTomlTopLevelBlock(toml, `model_catalog_json = ${JSON.stringify(catalogPath)}\n`);
    }

    const accessMode = readCodexAccessMode(codexHome);
    const sandboxMode = sandboxModeFor(accessMode);
    const sandboxBlock =
      sandboxMode === "workspace-write"
        ? `sandbox_mode = "workspace-write"\n[sandbox_workspace_write]\nnetwork_access = true\n`
        : `sandbox_mode = ${JSON.stringify(sandboxMode)}\n`;
    if (sandboxBlock) toml = insertTomlTopLevelBlock(toml, sandboxBlock);
    await mkdir(join(configFile, ".."), { recursive: true });
    await writeEngineFile(configFile, toml);
    await codexRuntimeSkillsFor(codexHome, runtimeServers);
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
  const key = codexManagerKey(handle, workspaceId);
  let manager = managersByKey.get(key);
  if (!manager) {
    // Legacy ~/.codex import only in the desktop runtime (bundled binary
    // present), never in isolated tests.
    const enableLegacyImport = Boolean(handle) && process.env.SOFIA_CODEX_IMPORT_LEGACY === "1";
    manager = createCodexSessionManager(handle, workspaceId, enableLegacyImport);
    managersByKey.set(key, manager);
  }
  let keys = managerKeysByConfig.get(config);
  if (!keys) {
    keys = new Set();
    managerKeysByConfig.set(config, keys);
  }
  keys.add(key);
  await manager.setSkillRoots(handle.skillRoots ?? []);
  await manager.refreshMcpConfiguration();
  return manager;
}

/**
 * Apply a workspace's saved MCP configuration to the codex engine.
 *
 * The engine has no runtime add/remove MCP RPC — it reads tool configuration
 * from `config.toml` — so a live change has to land on disk and then be
 * reloaded through `config/mcpServer/reload`. Only a running manager is
 * reloaded: writing the file is enough for the next engine start, and applying
 * configuration must never start an engine by itself.
 */
export async function applyCodexWorkspaceMcpConfiguration(config: ServerConfig, workspaceId: string): Promise<void> {
  const handle = await codexEngineHandleForConfig(config, workspaceId);
  if (!handle) return;
  const manager = managersByKey.get(codexManagerKey(handle, workspaceId));
  if (manager) {
    await manager.setSkillRoots(handle.skillRoots ?? []);
    await manager.refreshMcpConfiguration();
  }
}

export async function closeCodexManagersForConfig(config: ServerConfig): Promise<void> {
  const keys = managerKeysByConfig.get(config);
  if (!keys) return;
  managerKeysByConfig.delete(config);
  // A key another live config still references is shared: its engine stays up.
  const stillReferenced = new Set<string>();
  for (const otherKeys of managerKeysByConfig.values()) {
    for (const key of otherKeys) stillReferenced.add(key);
  }
  const closing = [...keys].filter((key) => !stillReferenced.has(key));
  await Promise.all(closing.map((key) => managersByKey.get(key)?.close() ?? Promise.resolve()));
  for (const key of closing) managersByKey.delete(key);
  perConfigBinary.delete(config);
}
