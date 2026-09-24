import { homedir } from "node:os";
import { join, relative } from "node:path";
import { readdir } from "node:fs/promises";
import type { PluginItem, ServerConfig } from "./types.js";
import { projectPluginsDir } from "./workspace-files.js";
import { exists } from "./utils.js";
import { validatePluginSpec } from "./validators.js";
import { readRuntimeWorkspaceEngineConfig, runtimePluginList, writeRuntimeWorkspaceEngineConfig } from "./runtime-engine-config-store.js";

export function normalizePluginSpec(spec: string): string {
  const trimmed = spec.trim();
  if (trimmed.startsWith("file:") || trimmed.startsWith("http:") || trimmed.startsWith("https:") || trimmed.startsWith("git:")) {
    return trimmed;
  }
  if (trimmed.startsWith("/")) {
    return trimmed;
  }
  if (trimmed.startsWith("@")) {
    const atIndex = trimmed.indexOf("@", 1);
    return atIndex > 0 ? trimmed.slice(0, atIndex) : trimmed;
  }
  const atIndex = trimmed.indexOf("@");
  return atIndex > 0 ? trimmed.slice(0, atIndex) : trimmed;
}

async function listPluginFiles(dir: string, scope: "project" | "global", workspaceRoot?: string): Promise<PluginItem[]> {
  if (!(await exists(dir))) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const items: PluginItem[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".js") && !entry.name.endsWith(".ts")) continue;
    const absolutePath = join(dir, entry.name);
    const relativePath = workspaceRoot ? relative(workspaceRoot, absolutePath) : absolutePath;
    items.push({
      spec: `file://${absolutePath}`,
      source: scope === "project" ? "dir.project" : "dir.global",
      scope,
      path: relativePath,
    });
  }
  return items;
}

export async function listPlugins(serverConfig: ServerConfig, workspaceId: string, workspaceRoot: string, includeGlobal: boolean): Promise<{ items: PluginItem[]; loadOrder: string[] }> {
  // Sofia no longer reads Sofia's config file: configured plugins come from
  // the runtime config store the server generates the engine config from.
  const pluginSpecs: string[] = [];
  const runtimeSpecs = runtimePluginList(await readRuntimeWorkspaceEngineConfig(serverConfig, workspaceId));
  const items: PluginItem[] = pluginSpecs.map((spec) => ({
    spec,
    source: "config",
    scope: "project",
  }));

  const seen = new Set(pluginSpecs.map((spec) => normalizePluginSpec(spec)));
  for (const spec of runtimeSpecs) {
    const normalized = normalizePluginSpec(spec);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    items.push({
      spec,
      source: "config",
      scope: "project",
    });
  }

  const projectDir = projectPluginsDir(workspaceRoot);
  items.push(...(await listPluginFiles(projectDir, "project", workspaceRoot)));

  if (includeGlobal) {
    const globalDir = join(homedir(), ".sofia", "plugins");
    items.push(...(await listPluginFiles(globalDir, "global")));
  }

  return {
    items,
    loadOrder: ["config.global", "config.project", "dir.global", "dir.project"],
  };
}

export async function addPlugin(serverConfig: ServerConfig, workspaceId: string, spec: string): Promise<boolean> {
  validatePluginSpec(spec);
  const runtimeConfig = await readRuntimeWorkspaceEngineConfig(serverConfig, workspaceId);
  const pluginSpecs = runtimePluginList(runtimeConfig);
  const normalized = normalizePluginSpec(spec);
  const existing = pluginSpecs.find((item) => normalizePluginSpec(item) === normalized);
  if (existing) return false;
  pluginSpecs.push(spec);
  await writeRuntimeWorkspaceEngineConfig(serverConfig, workspaceId, (current) => ({ ...current, plugin: pluginSpecs }));
  return true;
}

export async function removePlugin(serverConfig: ServerConfig, workspaceId: string, name: string): Promise<boolean> {
  const runtimeConfig = await readRuntimeWorkspaceEngineConfig(serverConfig, workspaceId);
  const pluginSpecs = runtimePluginList(runtimeConfig);
  const normalized = normalizePluginSpec(name);
  const filtered = pluginSpecs.filter((item) => normalizePluginSpec(item) !== normalized);
  if (filtered.length === pluginSpecs.length) return false;
  await writeRuntimeWorkspaceEngineConfig(serverConfig, workspaceId, (current) => ({ ...current, plugin: filtered }));
  return true;
}
