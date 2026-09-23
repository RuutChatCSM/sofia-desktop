// sofia-auth.json — credential store for the bundled Sofia (codex fork) engine.
// The UI model configuration writes provider API keys here (same keys it sends
// to opencode via its auth API); the engine reads them natively from
// `sofia-auth.json` in `$CODEX_HOME`, `~/.config/sofia`, then `~/.codex` (see
// the fork's ModelProviderInfo::api_key). Written as a flat `envKey -> key`
// map matching what the engine resolves by `env_key`.
import { readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const CODEX_AUTH_STORE_FILE = "sofia-auth.json";

/** Flat env var name -> API key map (what the engine reads by env_key). */
export type CodexAuthStore = Record<string, string>;

export function codexAuthStorePath(opts?: { env?: NodeJS.ProcessEnv }): string {
  // The engine home is pinned by the desktop (SOFIA_CODEX_HOME) to a real
  // path shared across dev/prod. Keep the credential store in that same home so
  // dev (sandbox HOME) and prod read/write the same sofia-auth.json; otherwise
  // the app writes keys where the engine can't find them. Mirrors
  // `codexHomeFor` in codex-registry.ts (SOFIA_CODEX_HOME, then CODEX_HOME,
  // then ~/.config/sofia/sofia).
  const env = opts?.env ?? process.env;
  if (env.SOFIA_PROVIDER_HOME?.trim()) return join(env.SOFIA_PROVIDER_HOME.trim(), CODEX_AUTH_STORE_FILE);
  const pinnedHome = env.SOFIA_HOME?.trim() || env.SOFIA_CODEX_HOME?.trim() || env.CODEX_HOME?.trim();
  if (pinnedHome) return join(pinnedHome, CODEX_AUTH_STORE_FILE);
  const home = env.HOME?.trim() || homedir();
  return join(home, ".sofia", CODEX_AUTH_STORE_FILE);
}

export async function readCodexAuthStore(opts?: { path?: string; env?: NodeJS.ProcessEnv }): Promise<CodexAuthStore> {
  const filePath = opts?.path ?? codexAuthStorePath({ env: opts?.env });
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const out: CodexAuthStore = {};
    for (const [envKey, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string" && value.trim()) out[envKey] = value.trim();
    }
    return out;
  } catch {
    return {};
  }
}

export async function writeCodexAuthStore(
  store: CodexAuthStore,
  opts?: { path?: string; env?: NodeJS.ProcessEnv },
): Promise<string> {
  const filePath = opts?.path ?? codexAuthStorePath({ env: opts?.env });
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return filePath;
}

export async function setCodexAuthKey(
  providerId: string,
  envKey: string,
  key: string,
  opts?: { path?: string; env?: NodeJS.ProcessEnv },
): Promise<string> {
  const store = await readCodexAuthStore(opts);
  store[envKey] = key;
  return writeCodexAuthStore(store, opts);
}

export async function removeCodexAuthKey(
  envKey: string,
  opts?: { path?: string; env?: NodeJS.ProcessEnv },
): Promise<void> {
  const store = await readCodexAuthStore(opts);
  if (!(envKey in store)) return;
  delete store[envKey];
  await writeCodexAuthStore(store, opts);
}

export async function clearCodexAuthStore(opts?: { path?: string; env?: NodeJS.ProcessEnv }): Promise<void> {
  const filePath = opts?.path ?? codexAuthStorePath({ env: opts?.env });
  try {
    await unlink(filePath);
  } catch {
    // Already absent.
  }
}
