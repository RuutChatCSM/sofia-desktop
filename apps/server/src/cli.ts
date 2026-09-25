#!/usr/bin/env bun

import { parseCliArgs, printHelp, resolveServerConfig } from "./config.js";
import { setCodexBinaryForConfig } from "./codex-registry.js";
import { createServerLogger, startServer } from "./server.js";
import { ensureLocalWorkspaceFiles } from "./workspace-init.js";
import { startWorkerActivityHeartbeat } from "./worker-activity-heartbeat.js";
import pkg from "../package.json" with { type: "json" };

const args = parseCliArgs(process.argv.slice(2));

if (args.help) {
  printHelp();
  process.exit(0);
}

if (args.version) {
  console.log(pkg.version);
  process.exit(0);
}

const config = await resolveServerConfig(args);
const logger = createServerLogger(config);

if (!config.readOnly) {
  await ensureLocalWorkspaceFiles(config.workspaces);
}

// The bundled Sofia engine is spawned per workspace, so the server only
// needs to know which binary to use. Resolution is owned by the embedding
// host (desktop) or the SOFIA_BIN env for headless deployments.
const sofiaBin = process.env.SOFIA_BIN?.trim() || process.env.SOFIA_CODEX_BIN?.trim();
if (sofiaBin) {
  setCodexBinaryForConfig(config, { path: sofiaBin, source: "custom" });
}

const server = await startServer(config);
config.port = server.port;
const workerActivityHeartbeat = startWorkerActivityHeartbeat(config, logger);

const url = `http://${config.host}:${server.port}`;
logger.log("info", `Sofia server listening on ${url}`);

if (config.tokenSource === "generated") {
  logger.log("info", `Client token: ${config.token}`);
}

if (config.hostTokenSource === "generated") {
  logger.log("info", `Host token: ${config.hostToken}`);
}

if (config.workspaces.length === 0) {
  logger.log("info", "No workspaces configured. Add --workspace or update server.json.");
} else {
  logger.log("info", `Workspaces: ${config.workspaces.length}`);
}

if (args.verbose) {
  logger.log("info", `Config path: ${config.configPath ?? "unknown"}`);
  logger.log("info", `Read-only: ${config.readOnly ? "true" : "false"}`);
  logger.log("info", `Approval: ${config.approval.mode} (${config.approval.timeoutMs}ms)`);
  logger.log("info", `CORS origins: ${config.corsOrigins.join(", ")}`);
  logger.log("info", `Authorized roots: ${config.authorizedRoots.join(", ")}`);
  logger.log("info", `Token source: ${config.tokenSource}`);
  logger.log("info", `Host token source: ${config.hostTokenSource}`);
}

const shutdown = async () => {
  workerActivityHeartbeat?.stop();
  (server as { stop?: (closeActiveConnections?: boolean) => void }).stop?.(true);
};

process.once("SIGINT", () => {
  void shutdown().finally(() => process.exit(0));
});
process.once("SIGTERM", () => {
  void shutdown().finally(() => process.exit(0));
});
