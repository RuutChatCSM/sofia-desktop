// Session-route adapter for the provider-auth store's `sofiaServer` slice.
//
// The settings route feeds the store the full sofia-server store, whose
// snapshot carries the server's real capabilities (including `providerSync`)
// and host-token auth. The session route used to fabricate a snapshot with
// hard-coded `{ config }` capabilities and no auth at all, so on the app's
// default surface `serverHandlesProviderSync()` was permanently false:
// PUT /den-session never fired after sign-in, the local server never learned
// the Den session, and server-side cloud provider sync never started (#3671).
//
// This adapter reports the truth for the endpoint it wraps:
// - local endpoints (the desktop's own Sofia App server) advertise
//   `providerSync: true` — every Sofia App server does
//   (apps/server/src/types.ts `Capabilities.providerSync: true`) — and carry
//   the live host token so the store can PUT /den-session and
//   POST /cloud-provider-sync/run;
// - remote workspaces keep the previous conservative shape (config only): a
//   desktop must not push its Den session to a shared remote worker.
import {
  createSofiaServerClient,
  isLoopbackSofiaServerUrl,
  readSofiaServerSettings,
  type SofiaServerClient,
} from "@/app/lib/sofia-server";
import type { ResolvedWorkspaceEndpoint } from "@/app/lib/workspace-endpoint";
import type { ProviderAuthSofiaServer } from "./store";

type SessionSofiaServerSnapshot = ReturnType<ProviderAuthSofiaServer["getSnapshot"]>;

export type CreateSessionSofiaServerInput = {
  endpoint: () => ResolvedWorkspaceEndpoint | null;
  /** Live host token from the desktop runtime (sofiaServerInfo). */
  hostToken?: () => string;
};

function resolveHostToken(endpoint: ResolvedWorkspaceEndpoint, live: string): string {
  if (live) return live;
  // Fallback mirrors sofia-server-store's getAuth(): persisted settings may
  // hold the host token (ensureDesktopLocalSofiaConnection writes it), but
  // only trust it for loopback servers — host tokens never travel off-machine.
  if (!isLoopbackSofiaServerUrl(endpoint.baseUrl)) return "";
  return readSofiaServerSettings().hostToken?.trim() ?? "";
}

export function createSessionSofiaServer(
  input: CreateSessionSofiaServerInput,
): ProviderAuthSofiaServer {
  let clientCacheKey = "";
  let clientCacheValue: SofiaServerClient | null = null;

  const hostAwareClient = (endpoint: ResolvedWorkspaceEndpoint, hostToken: string): SofiaServerClient => {
    if (!hostToken) return endpoint.client;
    const key = `${endpoint.baseUrl}\u001f${endpoint.token}\u001f${hostToken}`;
    if (key !== clientCacheKey || !clientCacheValue) {
      clientCacheKey = key;
      clientCacheValue = createSofiaServerClient({
        baseUrl: endpoint.baseUrl,
        token: endpoint.token || undefined,
        hostToken,
      });
    }
    return clientCacheValue;
  };

  return {
    getSnapshot: (): SessionSofiaServerSnapshot => {
      const endpoint = input.endpoint();
      if (!endpoint) {
        return {
          sofiaServerStatus: "disconnected",
          sofiaServerClient: null,
          sofiaServerCapabilities: null,
        };
      }
      if (endpoint.isRemote) {
        return {
          sofiaServerStatus: "connected",
          sofiaServerClient: endpoint.client,
          sofiaServerCapabilities: { config: { read: true, write: true } },
        };
      }
      const hostToken = resolveHostToken(endpoint, input.hostToken?.().trim() ?? "");
      return {
        sofiaServerStatus: "connected",
        sofiaServerClient: hostAwareClient(endpoint, hostToken),
        sofiaServerAuth: {
          token: endpoint.token || undefined,
          hostToken: hostToken || undefined,
        },
        sofiaServerCapabilities: {
          config: { read: true, write: true },
          providerSync: true,
        },
      };
    },
  };
}
