import { isAbsolute, join, normalize } from "node:path";

/** Read shared Codex skills in place; Sofia's own roots remain engine-owned. */
export function sharedCodexSkillRoots(config: Record<string, unknown>, realHome: string): string[] {
  const skills = config.skills;
  const disabled = skills !== null && typeof skills === "object" && "discoverCodexSkills" in skills && skills.discoverCodexSkills === false;
  const additional = skills !== null && typeof skills === "object" && "additionalDirectories" in skills ? skills.additionalDirectories : [];
  const directories = Array.isArray(additional) ? additional : [];
  const roots = disabled ? [] : [join(realHome, ".codex", "skills")];
  for (const directory of directories) {
    if (typeof directory !== "string" || !directory.trim()) continue;
    const path = directory.trim().startsWith("~/") ? join(realHome, directory.trim().slice(2)) : directory.trim();
    if (!isAbsolute(path)) throw new Error("Skill directories must be absolute paths or start with ~/.");
    roots.push(normalize(path));
  }
  return [...new Set(roots)];
}
