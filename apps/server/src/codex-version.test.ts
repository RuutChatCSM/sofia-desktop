import { describe, expect, test } from "bun:test";

import {
  compareVersions,
  extractVersionFromOutput,
  hasCodexFeature,
  parseVersion,
  versionAtLeast,
} from "./codex-version.js";

describe("codex-version", () => {
  test("parseVersion parses release and prerelease", () => {
    expect(parseVersion("0.149.1")).toEqual({ major: 0, minor: 149, patch: 1, prerelease: [], raw: "0.149.1" });
    const alpha = parseVersion("0.148.0-alpha.3");
    expect(alpha?.major).toBe(0);
    expect(alpha?.minor).toBe(148);
    expect(alpha?.prerelease).toEqual(["alpha", "3"]);
  });

  test("parseVersion rejects junk", () => {
    expect(parseVersion("not-a-version")).toBeNull();
    expect(parseVersion("")).toBeNull();
  });

  test("compareVersions orders release and prerelease", () => {
    expect(compareVersions("0.149.1", "0.149.1")).toBe(0);
    expect(compareVersions("0.149.1", "0.148.0")).toBeGreaterThan(0);
    expect(compareVersions("0.148.0-alpha.3", "0.148.0")).toBeLessThan(0);
    // release > its own prerelease
    expect(compareVersions("0.148.0", "0.148.0-alpha.3")).toBeGreaterThan(0);
    // prerelease ordering
    expect(compareVersions("0.148.0-beta.1", "0.148.0-alpha.3")).toBeGreaterThan(0);
    // numeric vs alnum prerelease
    expect(compareVersions("0.148.0-1", "0.148.0-alpha.3")).toBeLessThan(0);
  });

  test("versionAtLeast", () => {
    expect(versionAtLeast("0.149.1", "0.141.0")).toBe(true);
    expect(versionAtLeast("0.140.9", "0.141.0")).toBe(false);
    expect(versionAtLeast("0.149.1", "0.149.1")).toBe(true);
    expect(versionAtLeast("0.148.0-alpha.3", "0.148.0-alpha.2")).toBe(true);
  });

  test("extractVersionFromOutput pulls a semver from paste", () => {
    expect(extractVersionFromOutput("codex-cli 0.149.1")).toBe("0.149.1");
    expect(extractVersionFromOutput("Codex 0.148.0-alpha.3")).toBe("0.148.0-alpha.3");
    expect(extractVersionFromOutput("hello")).toBeNull();
  });

  test("hasCodexFeature gates per-feature minimums like the app's Rte table", () => {
    // The bundled Sofia fork (0.149.1) clears every feature gate.
    expect(hasCodexFeature("0.149.1", "compactionImageBudget")).toBe(true);
    expect(hasCodexFeature("0.149.1", "projects")).toBe(true);
    expect(hasCodexFeature("0.149.1", "threadRevert")).toBe(true);
    expect(hasCodexFeature("0.149.1", "diagnostics")).toBe(true);
    // Below a gate: feature not usable.
    expect(hasCodexFeature("0.140.0", "threadRevert")).toBe(false);
    expect(hasCodexFeature("0.140.0", "projects")).toBe(false);
    // Unknown / missing version never grants a feature.
    expect(hasCodexFeature(null, "threadRevert")).toBe(false);
    expect(hasCodexFeature("0.0.0", "threadRevert")).toBe(false);
    // Prerelease-aware: 0.148.0-alpha.3 clears diagnostics exactly at its gate.
    expect(hasCodexFeature("0.148.0-alpha.3", "diagnostics")).toBe(true);
    expect(hasCodexFeature("0.148.0-alpha.2", "diagnostics")).toBe(false);
  });
});
