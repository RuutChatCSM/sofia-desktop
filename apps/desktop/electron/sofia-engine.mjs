import { existsSync } from "node:fs";
import path from "node:path";

/** Resolve the same Sofia engine for desktop startup and engine diagnostics. */
export function resolveSofiaEngine({ env = process.env, home, sidecarDirs = [], platform = process.platform }) {
  const explicit = env.SOFIA_BIN?.trim() || env.SOFIA_CODEX_BIN?.trim();
  if (explicit) return { path: explicit, source: "custom" };
  const name = platform === "win32" ? "sofia.exe" : "sofia";
  const bundled = (names = [name]) => {
    for (const directory of sidecarDirs) {
      // The old filename is accepted for previously packaged installations.
      for (const file of names) {
        const candidate = path.join(directory, file);
        if (existsSync(candidate)) return { path: candidate, source: "bundled" };
      }
    }
    return null;
  };
  const legacyName = platform === "win32" ? "codex.exe" : "codex";
  if ((env.SOFIA_DEV_ENGINE ?? env.SOFIA_DEV_CODEX)?.trim() === "1") return bundled([name, legacyName]);
  // Use the Sofia binary built with this app so installed releases cannot mask
  // engine fixes. Old renamed sidecars remain the last migration fallback.
  const shipped = bundled();
  if (shipped) return shipped;
  for (const entry of (env.PATH ?? "").split(platform === "win32" ? ";" : ":").filter(Boolean)) {
    const candidate = path.join(entry, name);
    if (existsSync(candidate)) return { path: candidate, source: "path" };
  }
  for (const directory of [
    path.join(home, ".local", "bin"),
    path.join(home, ".sofia", "packages", "standalone", "current", "bin"),
    "/opt/homebrew/bin", "/usr/local/bin",
  ]) {
    const candidate = path.join(directory, name);
    if (existsSync(candidate)) return { path: candidate, source: "known-location" };
  }
  return bundled([legacyName]);
}
