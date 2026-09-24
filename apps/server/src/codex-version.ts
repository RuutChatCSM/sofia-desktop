// Codex version helpers: parse the `codex --version` string and compare semver
// (with prerelease + build metadata) and check per-feature minimums. The
// app-server engine itself does not hard-gate on a minimum version — Sofia App
// only ever runs its own bundled Sofia binary — so version is probed for
// diagnostics and feature-gating, never to refuse startup.

/**
 * Per-feature minimum app-server versions, mirroring the ChatGPT/Codex app's
 * feature-gate table (`Rte`). A feature is usable on a given binary when its
 * reported version is >= the gate for that feature.
 */
export const CODEX_FEATURE_GATES = {
  /** Compaction with a bounded image budget (`thread/start.compactionImageBudget`). */
  compactionImageBudget: "0.149.1",
  /** Agent diagnostics streaming (`diagnostics` events). */
  diagnostics: "0.148.0-alpha.3",
  /** MCP OAuth login thread id (login via an MCP thread). */
  mcpOauthLoginThreadId: "0.143.0-alpha.26",
  /** Project-scoped workspaces (projects). */
  projects: "0.148.0-alpha.21",
  /** Provider/model fallback when the primary provider is unreachable. */
  providerModelFallback: "0.143.0-alpha.26",
  /** Revert a thread to an earlier state (`thread/revert`). */
  threadRevert: "0.148.0-alpha.13",
} as const;

export type CodexFeature = keyof typeof CODEX_FEATURE_GATES;

/** True if the reported codex version is >= the gate for `feature`. */
export function hasCodexFeature(version: string | null | undefined, feature: CodexFeature): boolean {
  if (!version) return false;
  return versionAtLeast(version, CODEX_FEATURE_GATES[feature]);
}

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export type ParsedVersion = {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
  raw: string;
};

/** Parse "0.149.1" or "0.148.0-alpha.3" into {major,minor,patch,prerelease}. */
export function parseVersion(value: string): ParsedVersion | null {
  const match = SEMVER.exec(value.trim());
  if (!match) return null;
  const prerelease = match[4]
    ? match[4].split(".").map((part) => part.replace(/^0+/, "") || "0")
    : [];
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease, raw: value.trim() };
}

/**
 * Compare two version strings. Returns <0 if a < b, >0 if a > b, 0 if equal.
 * Handles prerelease (a release with a prerelease is lower than the same
 * release without one), and meters prerelease segments numerically when
 * possible, lexically otherwise. Build metadata is ignored.
 */
export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a) return 0;
  if (!b) return 0;
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;

  // Equal major.minor.patch: a release with NO prerelease is the highest.
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1; // a is a release, b is prerelease
  if (b.prerelease.length === 0) return -1;

  const len = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < len; i++) {
    const pa = a.prerelease[i];
    const pb = b.prerelease[i];
    if (pa === undefined) return -1; // fewer identifiers is lower
    if (pb === undefined) return 1;
    if (pa === pb) continue;
    const na = Number(pa);
    const nb = Number(pb);
    const aNumeric = !Number.isNaN(na);
    const bNumeric = !Number.isNaN(nb);
    if (aNumeric && bNumeric) return na < nb ? -1 : 1;
    if (aNumeric) return -1; // numeric identifiers are lower than alphanumeric
    if (bNumeric) return 1;
    return pa < pb ? -1 : 1;
  }
  return 0;
}

/** True if `version` is >= `minimum` (semver, with prerelease awareness). */
export function versionAtLeast(version: string, minimum: string): boolean {
  return compareVersions(version, minimum) >= 0;
}

/** Extract a version from a `codex --version` command's first output line. */
export function extractVersionFromOutput(output: string): string | null {
  const match = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)/.exec(output);
  return match ? match[1] : null;
}
