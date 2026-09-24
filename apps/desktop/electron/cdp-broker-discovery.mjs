// The in-app browser harness (`apps/server/src/sofia-browser-repl.mjs`) is
// launched by the Sofia engine from `config.toml`, which records whatever broker
// URL the app had at the moment it wrote that file. The port is ephemeral and
// every build rewrites the same shared `config.toml`, so a stale entry outlives
// the app that wrote it and leaves the agent with a browser tool that cannot
// connect: the MCP server still starts, but every call fails or hangs.
//
// This module publishes the live endpoint to a discovery file in the Sofia
// engine home, mirroring `sofia-ui-control.json` for the UI-control bridge. The
// harness re-reads it whenever the URL it was started with is unreachable, so a
// stale registration self-heals.
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const CDP_BROKER_DISCOVERY_FILENAME = "sofia-cdp-broker.json";

/** Discovery file the browser harness reads. Null when the engine home is unknown. */
export function cdpBrokerDiscoveryPath(sofiaHome) {
  const home = sofiaHome?.trim();
  return home ? path.join(home, CDP_BROKER_DISCOVERY_FILENAME) : null;
}

/**
 * Publish the live broker endpoint. Best-effort: the harness still works from
 * `SOFIA_BROWSER_CDP_URL` when the file is missing, it just cannot self-heal a
 * stale registration.
 */
export async function writeCdpBrokerDiscovery({ sofiaHome, url, appIdentifier, pid, now = Date.now() }) {
  const file = cdpBrokerDiscoveryPath(sofiaHome);
  const endpoint = url?.trim();
  if (!file || !endpoint) return null;
  await mkdir(path.dirname(file), { recursive: true });
  const record = {
    schemaVersion: 1,
    url: endpoint,
    appIdentifier: appIdentifier ?? null,
    pid: pid ?? null,
    updatedAt: new Date(now).toISOString(),
  };
  await writeFile(file, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return file;
}

/** Drop the discovery file on quit so a later launch cannot read a dead port. */
export async function clearCdpBrokerDiscovery({ sofiaHome }) {
  const file = cdpBrokerDiscoveryPath(sofiaHome);
  if (!file) return null;
  await rm(file, { force: true });
  return file;
}
