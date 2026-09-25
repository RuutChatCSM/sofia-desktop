/**
 * Single source of truth for "where does a workspace's server live?".
 *
 * Every workspace-scoped API call in the app must route to the Sofia server
 * that actually owns that workspace. For local workspaces that's the user's
 * local Sofia server. For workspaces hosted on a remote Sofia worker
 * (`id` starts with `rem_` and `workspaceType === "remote"`), it's the
 * `baseUrl`/`sofiaHostUrl` and `sofiaToken` saved on the workspace
 * record, with the workspace addressed by its server-side id (the `rem_`
 * prefix is stripped, or `sofiaWorkspaceId` is used when present).
 *
 * Always go through {@link resolveWorkspaceEndpoint} when you need:
 *   - an `SofiaServerClient` for a workspace
 *   - a mounted `/workspace/<id>` URL prefix
 *   - the `/engine` URL for the Sofia SDK
 *
 * Don't compose `<baseUrl>/workspace/<id>` by hand — that pattern is what
 * caused this whole class of "remote workspace API calls hit the local
 * server" bugs.
 */

import type { WorkspaceInfo } from "./desktop";
import {
  buildSofiaWorkspaceBaseUrl,
  createSofiaServerClient,
  type SofiaServerClient,
} from "./sofia-server";

export type ResolvedWorkspaceEndpoint = {
  /** Host URL of the Sofia server that owns this workspace (no `/workspace` mount). */
  baseUrl: string;
  /** Auth token for that server. May be empty for unauthenticated local servers. */
  token: string;
  /** Workspace id as the owning server expects it in URL paths. No `rem_` prefix. */
  workspaceId: string;
  /** True when the workspace lives on a remote Sofia worker, not the user's local server. */
  isRemote: boolean;
  /** SofiaServerClient bound to {@link baseUrl}/{@link token}. */
  client: SofiaServerClient;
  /** Mounted base url: `<baseUrl>/workspace/<workspaceId>`. No trailing slash. */
  mountedBaseUrl: string;
  /** Sofia SDK base url: `<mountedBaseUrl>/engine`. */
  engineBaseUrl: string;
};

export type LocalServerHandle = {
  baseUrl: string | null | undefined;
  token: string | null | undefined;
};

type WorkspaceEndpointInput = Pick<
  WorkspaceInfo,
  | "id"
  | "workspaceType"
  | "baseUrl"
  | "sofiaHostUrl"
  | "sofiaToken"
  | "sofiaClientToken"
  | "sofiaHostToken"
  | "sofiaWorkspaceId"
> | null | undefined;

/**
 * Cheap predicate. Use this instead of duplicating the `id.startsWith("rem_")`
 * check inline.
 */
export function isRemoteWorkspace(workspace: WorkspaceEndpointInput): boolean {
  if (!workspace) return false;
  return (
    workspace.id.trim().startsWith("rem_") &&
    workspace.workspaceType === "remote"
  );
}

/**
 * Returns the server-side workspace id (no `rem_` prefix) for any workspace.
 * For local workspaces, returns the id as-is.
 */
export function workspaceServerId(workspace: WorkspaceEndpointInput): string {
  if (!workspace) return "";
  const id = workspace.id.trim();
  if (!isRemoteWorkspace(workspace)) return id;
  const explicit = workspace.sofiaWorkspaceId?.trim();
  if (explicit) return explicit;
  return id.startsWith("rem_") ? id.slice("rem_".length) : id;
}

function pickRemoteBaseUrl(workspace: WorkspaceEndpointInput): string {
  if (!workspace) return "";
  return (workspace.baseUrl ?? workspace.sofiaHostUrl ?? "").trim();
}

function pickRemoteToken(workspace: WorkspaceEndpointInput): string {
  if (!workspace) return "";
  return (
    workspace.sofiaToken ??
    workspace.sofiaClientToken ??
    workspace.sofiaHostToken ??
    ""
  ).trim();
}

/**
 * Resolve the right server endpoint for a workspace. Returns null when the
 * workspace can't be reached (remote with no baseUrl, or local with no local
 * server connected yet). The returned object's `client`, `mountedBaseUrl`, and
 * `engineBaseUrl` are ready to use for any workspace-scoped API call.
 */
export function resolveWorkspaceEndpoint(
  workspace: WorkspaceEndpointInput,
  localServer: LocalServerHandle,
): ResolvedWorkspaceEndpoint | null {
  if (!workspace) return null;

  if (isRemoteWorkspace(workspace)) {
    const baseUrl = pickRemoteBaseUrl(workspace);
    if (!baseUrl) return null;
    const token = pickRemoteToken(workspace);
    const workspaceId = workspaceServerId(workspace);
    const client = createSofiaServerClient({
      baseUrl,
      token: token || undefined,
    });
    const mountedBaseUrl = (
      buildSofiaWorkspaceBaseUrl(baseUrl, workspaceId) ?? baseUrl
    ).replace(/\/+$/, "");
    return {
      baseUrl,
      token,
      workspaceId,
      isRemote: true,
      client,
      mountedBaseUrl,
      engineBaseUrl: `${mountedBaseUrl}/engine`,
    };
  }

  const localBaseUrl = (localServer.baseUrl ?? "").trim();
  if (!localBaseUrl) return null;
  const localToken = (localServer.token ?? "").trim();
  const workspaceId = workspace.id.trim();
  const client = createSofiaServerClient({
    baseUrl: localBaseUrl,
    token: localToken || undefined,
  });
  const mountedBaseUrl = (
    buildSofiaWorkspaceBaseUrl(localBaseUrl, workspaceId) ?? localBaseUrl
  ).replace(/\/+$/, "");
  return {
    baseUrl: localBaseUrl,
    token: localToken,
    workspaceId,
    isRemote: false,
    client,
    mountedBaseUrl,
    engineBaseUrl: `${mountedBaseUrl}/engine`,
  };
}
