/**
 * Single entry point for embedding the Sofia server in-process.
 *
 * Handles config resolution, Sofia engine binary wiring, and server start in
 * one call -- mirrors what cli.ts does but returns a handle instead of owning
 * the process lifecycle.
 */
import { resolveServerConfig, type CliArgs } from "./config.js";
import { setCodexBinaryForConfig, closeCodexManagersForConfig } from "./codex-registry.js";
import { startServer } from "./server.js";
import { ensureLocalWorkspaceFiles } from "./workspace-init.js";
import type { ServeResult } from "./serve-node.js";
import type { LocalManagedMcpVaultKeyProvider, ServerConfig } from "./types.js";

export type EmbeddedServerOptions = CliArgs & {
  /** Path to the Sofia engine. Falls back to SOFIA_BIN. */
  sofiaBin?: string;
  /** Compatibility with previously packaged desktop runtimes. */
  codexBin?: string;
  /** Secure key custody for the local managed MCP credential vault. */
  localManagedMcpVaultKey?: LocalManagedMcpVaultKeyProvider;
};

export type EmbeddedServerHandle = {
  /** Bound port the HTTP server is listening on. */
  port: number;
  /** Full base URL, e.g. http://127.0.0.1:48123 */
  url: string;
  /** The resolved server config. */
  config: ServerConfig;
  /** Stop the HTTP server and close the Codex engine managers (if any). */
  stop: () => Promise<void>;
};

export async function startEmbeddedServer(options: EmbeddedServerOptions): Promise<EmbeddedServerHandle> {
  const config = await resolveServerConfig(options);
  config.localManagedMcpVaultKey = options.localManagedMcpVaultKey;

  let server: ServeResult | null = null;
  let stopPromise: Promise<void> | null = null;

  const releaseResources = async (): Promise<void> => {
    const errors: unknown[] = [];

    try {
      await closeCodexManagersForConfig(config);
    } catch {
      // cleanup is best-effort
    }

    const httpServer = server;
    server = null;
    if (httpServer) {
      try {
        await httpServer.stop();
      } catch (error) {
        errors.push(error);
      }
    }

    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, "Failed to stop embedded Sofia server");
    }
  };

  const stop = (): Promise<void> => {
    stopPromise ??= releaseResources();
    return stopPromise;
  };

  const duringStartup = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (startupError) {
      try {
        await stop();
      } catch (cleanupError) {
        throw new AggregateError(
          [startupError, cleanupError],
          "Embedded Sofia server startup failed and cleanup was incomplete",
        );
      }
      throw startupError;
    }
  };

  if (!config.readOnly) {
    await ensureLocalWorkspaceFiles(config.workspaces);
  }

  // The desktop passes the resolved Sofia engine; headless hosts use SOFIA_BIN.
  const sofiaBin = options.sofiaBin || process.env.SOFIA_BIN?.trim() || options.codexBin || process.env.SOFIA_CODEX_BIN?.trim();
  if (sofiaBin) {
    setCodexBinaryForConfig(config, { path: sofiaBin, source: "custom" });
  }

  server = await duringStartup(() => startServer(config));
  config.port = server.port;

  return {
    port: server.port,
    url: `http://${config.host === "0.0.0.0" ? "127.0.0.1" : config.host}:${server.port}`,
    config,
    stop,
  };
}
