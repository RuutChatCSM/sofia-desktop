// Public engine-client facade.
//
// Historically this module wrapped the Sofia SDK. The SDK is gone; the
// implementation now lives in `./engine-client` and talks to the Sofia App
// server's adapter-backed REST routes and native Codex surface. Call sites keep
// importing `createClient`/`unwrap` from here unchanged.
import { createEngineClient, type EngineResult, type WorkspaceEngineAuth } from "./engine-client";

export type { EngineResult, WorkspaceEngineAuth } from "./engine-client";

export function createClient(
  baseUrl: string,
  directory?: string,
  auth?: WorkspaceEngineAuth,
  fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
) {
  return createEngineClient({
    baseUrl,
    directory,
    auth,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
}

export type EngineClient = ReturnType<typeof createClient>;

export function unwrap<T>(result: EngineResult<T>): NonNullable<T> {
  if (result.data !== undefined) {
    return result.data as NonNullable<T>;
  }
  const message =
    result.error instanceof Error
      ? result.error.message
      : typeof result.error === "string"
        ? result.error
        : JSON.stringify(result.error);
  throw new Error(message || "Unknown error");
}

export async function waitForHealthy(
  client: EngineClient,
  options?: { timeoutMs?: number; pollMs?: number },
) {
  const timeoutMs = options?.timeoutMs ?? 10_000;
  const pollMs = options?.pollMs ?? 250;

  const start = Date.now();
  let lastError: string | null = null;

  while (Date.now() - start < timeoutMs) {
    try {
      const health = unwrap(await client.global.health());
      if (health.healthy) {
        return health;
      }
      lastError = "Server reported unhealthy";
    } catch (error) {
      lastError = error instanceof Error ? error.message : "Unknown error";
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  throw new Error(lastError ?? "Timed out waiting for server health");
}
