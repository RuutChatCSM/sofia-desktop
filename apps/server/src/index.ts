/**
 * Library entry point for the Sofia server.
 *
 * ```ts
 * import { startEmbeddedServer } from "sofia-server";
 *
 * const handle = await startEmbeddedServer({
 *   host: "127.0.0.1",
 *   port: 0,
 *   workspaces: ["/path/to/workspace"],
 *   token: clientToken,
 *   hostToken: hostToken,
 *   codexBin: "/path/to/codex",
 * });
 *
 * console.log(`Server at ${handle.url}`);
 * handle.stop();
 * ```
 */
export { startEmbeddedServer, type EmbeddedServerHandle, type EmbeddedServerOptions } from "./embedded.js";
export { startServer } from "./server.js";
export { resolveServerConfig } from "./config.js";
export type { ServeResult } from "./serve-node.js";
