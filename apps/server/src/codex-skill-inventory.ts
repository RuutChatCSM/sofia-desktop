import { dirname, isAbsolute, join, relative } from "node:path";
import type { SkillItem } from "./types.js";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Project the engine's effective catalog, preserving its selected skill paths. */
export function discoveredSkillInventory(response: unknown, managed: SkillItem[], workspaceRoot?: string): SkillItem[] {
  if (!record(response) || !Array.isArray(response.data)) throw new Error("Invalid engine skill catalog");
  const localByPath = new Map(managed.map(skill => [skill.path, skill]));
  const byPath = new Map<string, SkillItem>();
  for (const entry of response.data) {
    if (!record(entry) || !Array.isArray(entry.skills)) continue;
    for (const skill of entry.skills) {
      if (!record(skill) || skill.enabled === false || typeof skill.name !== "string" || typeof skill.path !== "string") continue;
      const local = localByPath.get(skill.path);
      const managedPath = workspaceRoot ? relative(join(workspaceRoot, ".sofia", "skills"), skill.path) : null;
      byPath.set(skill.path, {
        ...local,
        name: skill.name,
        path: skill.path,
        description: typeof skill.description === "string" ? skill.description : "",
        scope: skill.scope === "repo" ? "project" : "global",
        sourceDirectory: dirname(skill.path),
        readOnly: !local && !(managedPath && !managedPath.startsWith("..") && !isAbsolute(managedPath)),
      });
    }
  }
  return [...byPath.values()];
}
