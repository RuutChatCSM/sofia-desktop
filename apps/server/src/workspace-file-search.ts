import { readdir } from "node:fs/promises";
import { join } from "node:path";

const EXCLUDED = new Set([".git", "node_modules", "target", "dist", ".next", ".cache"]);

/** Bounded, workspace-only discovery for the composer. Never follows symlinks. */
export async function searchWorkspaceFiles(root: string, query: string, limit = 50): Promise<string[]> {
  const needle = query.trim().toLocaleLowerCase();
  const matches: string[] = [];
  const directories = [""];
  let visited = 0;
  for (let cursor = 0; cursor < directories.length && visited < 10_000; cursor++) {
    const directory = directories[cursor];
    const entries = await readdir(join(root, directory), { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (directory && ["EACCES", "ENOENT", "EPERM"].includes(error.code ?? "")) return [];
      throw error;
    });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (++visited > 10_000) break;
      if (EXCLUDED.has(entry.name) || entry.isSymbolicLink()) continue;
      const path = directory ? `${directory}/${entry.name}` : entry.name;
      if (entry.isDirectory()) directories.push(path);
      if ((entry.isFile() || entry.isDirectory()) && path.toLocaleLowerCase().includes(needle)) {
        matches.push(entry.isDirectory() ? `${path}/` : path);
        if (matches.length >= limit) return matches;
      }
    }
  }
  return matches;
}
