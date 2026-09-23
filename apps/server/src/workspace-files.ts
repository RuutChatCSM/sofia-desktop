import { join } from "node:path";

/**
 * Workspace-local directory Sofia owns.
 *
 * Sofia no longer reads or writes OpenCode's `.opencode` directory or its
 * `opencode.json(c)` config files. Workspace skills, commands, and plugins
 * live under `.sofia`, and the engine config is generated from the runtime
 * config store into the Sofia home (`~/.sofia/config.toml`).
 */
export function sofiaWorkspaceDir(workspaceRoot: string): string {
  return join(workspaceRoot, ".sofia");
}

export function projectSkillsDir(workspaceRoot: string): string {
  return join(sofiaWorkspaceDir(workspaceRoot), "skills");
}

export function projectCommandsDir(workspaceRoot: string): string {
  return join(sofiaWorkspaceDir(workspaceRoot), "commands");
}

export function projectPluginsDir(workspaceRoot: string): string {
  return join(sofiaWorkspaceDir(workspaceRoot), "plugins");
}
