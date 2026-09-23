import { basename } from "node:path";
import { readFile } from "node:fs/promises";

import { ensureDir, exists } from "./utils.js";
import { ApiError } from "./errors.js";
import type { ReloadReason, WorkspaceInfo } from "./types.js";

type WorkspaceSofiaConfig = {
  version: number;
  workspace?: {
    name?: string | null;
    createdAt?: number | null;
    preset?: string | null;
  } | null;
  authorizedRoots: string[];
  reload?: {
    auto?: boolean;
    resume?: boolean;
  } | null;
};

type EnsureWorkspaceFilesResult = {
  changed: boolean;
  reloadReasons: ReloadReason[];
};

function normalizePreset(preset: string | null | undefined): string {
  const trimmed = preset?.trim() ?? "";
  if (!trimmed) return "starter";
  return trimmed;
}

function errorStringField(error: unknown, field: "code" | "path" | "syscall"): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const value = Object.getOwnPropertyDescriptor(error, field)?.value;
  return typeof value === "string" ? value : undefined;
}

/**
 * Build the default per-workspace sofia config metadata. The sofia
 * config is now stored in the runtime DB (see
 * `seedSofiaWorkspaceConfigIfEmpty`), not in `.opencode/sofia.json`, so
 * this no longer writes a file. Exposed so the workspace-creation route can
 * seed the DB row with the same defaults.
 */
export function defaultWorkspaceSofiaConfig(workspaceRoot: string, preset: string): WorkspaceSofiaConfig {
  return {
    version: 1,
    workspace: {
      name: basename(workspaceRoot) || "Workspace",
      createdAt: Date.now(),
      preset,
    },
    authorizedRoots: [workspaceRoot],
    reload: null,
  };
}

export async function ensureWorkspaceFiles(workspaceRoot: string, presetInput: string): Promise<EnsureWorkspaceFilesResult> {
  const preset = normalizePreset(presetInput);
  if (!workspaceRoot.trim()) {
    throw new ApiError(400, "invalid_workspace_path", "workspace path is required");
  }
  try {
    await ensureDir(workspaceRoot);
  } catch (error) {
    throw new ApiError(409, "workspace_inaccessible", "Workspace path is not accessible", {
      path: workspaceRoot,
      fsCode: errorStringField(error, "code"),
      syscall: errorStringField(error, "syscall"),
      fsPath: errorStringField(error, "path"),
    });
  }
  // Sofia owns no engine config file in the workspace: engine config is
  // generated from the runtime DB, and the workspace sofia config is seeded
  // into that DB by the caller.
  const reloadReasons = new Set<ReloadReason>();
  void preset;
  return {
    changed: reloadReasons.size > 0,
    reloadReasons: Array.from(reloadReasons),
  };
}

/**
 * Provision workspace files for every workspace that has local files to set up.
 *
 * Skips remote workspaces (which live on a host and may even carry a non-empty
 * remote `directory`) and any workspace without a resolved local path. Either
 * would otherwise reach ensureWorkspaceFiles() — which throws
 * `invalid_workspace_path` on a blank path — and abort server startup. Local
 * provisioning failures are logged and skipped so one stale path cannot abort
 * startup. Shared by the embedded-server and CLI boot paths.
 */
export async function ensureLocalWorkspaceFiles(
  workspaces: ReadonlyArray<Pick<WorkspaceInfo, "path" | "preset" | "workspaceType">>,
): Promise<void> {
  for (const workspace of workspaces) {
    if (workspace.workspaceType === "remote" || !workspace.path.trim()) continue;
    try {
      await ensureWorkspaceFiles(workspace.path, workspace.preset);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Failed to provision workspace files at ${workspace.path}: ${message}`);
    }
  }
}

export async function readRawOpencodeConfig(path: string): Promise<{ exists: boolean; content: string | null }> {
  const hasFile = await exists(path);
  if (!hasFile) {
    return { exists: false, content: null };
  }
  const content = await readFile(path, "utf8");
  return { exists: true, content };
}
