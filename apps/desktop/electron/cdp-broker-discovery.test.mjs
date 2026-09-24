import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CDP_BROKER_DISCOVERY_FILENAME,
  cdpBrokerDiscoveryPath,
  clearCdpBrokerDiscovery,
  writeCdpBrokerDiscovery,
} from "./cdp-broker-discovery.mjs";

test("publishes the live broker endpoint next to the engine home", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "sofia-cdp-broker-"));
  try {
    const file = await writeCdpBrokerDiscovery({
      sofiaHome: home,
      url: "http://127.0.0.1:65185",
      appIdentifier: "app.sofia.desktop.dev",
      pid: 4242,
      now: Date.UTC(2026, 8, 24, 9, 0, 0),
    });
    assert.equal(file, path.join(home, CDP_BROKER_DISCOVERY_FILENAME));
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), {
      schemaVersion: 1,
      url: "http://127.0.0.1:65185",
      appIdentifier: "app.sofia.desktop.dev",
      pid: 4242,
      updatedAt: "2026-09-24T09:00:00.000Z",
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("clearing removes the endpoint so a later launch cannot read a dead port", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "sofia-cdp-broker-"));
  try {
    const file = await writeCdpBrokerDiscovery({ sofiaHome: home, url: "http://127.0.0.1:1" });
    await clearCdpBrokerDiscovery({ sofiaHome: home });
    await assert.rejects(readFile(file, "utf8"), { code: "ENOENT" });
    await clearCdpBrokerDiscovery({ sofiaHome: home });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("no engine home means nothing to write or clear", async () => {
  assert.equal(cdpBrokerDiscoveryPath(""), null);
  assert.equal(await writeCdpBrokerDiscovery({ sofiaHome: "  ", url: "http://127.0.0.1:1" }), null);
  assert.equal(await clearCdpBrokerDiscovery({ sofiaHome: undefined }), null);
});
