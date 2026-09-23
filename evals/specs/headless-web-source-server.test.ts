import path from "node:path";
import { expect } from "vitest";
import { test } from "@sofia/testkit";

import {
  buildHeadlessServerLaunch,
  resolveHeadlessSofiaHome,
  resolveHeadlessProviderHome,
} from "../../scripts/dev-headless-web-lib";

test("headless web development launches the server from current source", ({ evidence }) => {
  const launch = buildHeadlessServerLaunch("/repo/sofia", ["--port", "8787"]);

  expect(launch).toEqual({
    command: "bun",
    args: [
      "--conditions=development",
      path.join("/repo/sofia", "apps/server/src/cli.ts"),
      "--port",
      "8787",
    ],
  });
  expect(launch.args.join(" ")).not.toContain("apps/server/dist");
  expect(launch.args.join(" ")).not.toContain("sofia-server");

  evidence.recordAssertionEvidence(
    "Local headless development is source-first",
    "The launch command executes apps/server/src/cli.ts and never references compiled server output, so a stale dist binary cannot affect a restarted development stack.",
    true,
  );
});

test("headless engine state is isolated from the desktop while providers stay shared", ({ evidence }) => {
  // Engine home defaults under the repo tmp/, never the desktop's ~/.sofia.
  expect(resolveHeadlessSofiaHome("/repo/sofia", { HOME: "/home/alice" })).toBe(
    path.join("/repo/sofia", "tmp", "headless-sofia-home"),
  );
  // Explicit override wins.
  expect(
    resolveHeadlessSofiaHome("/repo/sofia", { HOME: "/home/alice", SOFIA_CODEX_HOME: "/state/engine" }),
  ).toBe("/state/engine");

  // Provider catalog stays shared with the desktop so connected providers and
  // credentials resolve identically.
  expect(resolveHeadlessProviderHome({ HOME: "/home/alice" })).toBe("/home/alice/.sofia");
  expect(resolveHeadlessProviderHome({ HOME: "/home/alice", SOFIA_PROVIDER_HOME: "/shared/providers" })).toBe(
    "/shared/providers",
  );
  expect(resolveHeadlessProviderHome({})).toBeNull();

  evidence.recordAssertionEvidence(
    "Headless engine state is isolated; provider catalog is shared",
    "resolveHeadlessSofiaHome defaults to <repo>/tmp/headless-sofia-home (not ~/.sofia), so a headless stack never runs a second engine against the desktop's SQLite/rollout store, while resolveHeadlessProviderHome keeps pointing at ~/.sofia so providers/credentials stay common.",
    true,
  );
});
