// Sofia prompt harness: builds the small Sofia-specific developer context
// added to every new thread. The engine keeps ownership of its base prompt,
// project-instruction discovery, skills, and normal Sofia behavior.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type PromptHarnessContext = {
  workspaceId: string;
  cwd: string;
};

/** Build factual host context without changing the engine's behavior policy. */
export function buildSofiaDeveloperInstructions(context: PromptHarnessContext): string {
  return [
    "<sofia_context>",
    "Sofia is running this thread and displaying it in the Sofia app.",
    `Workspace id: ${context.workspaceId}`,
    `Working directory: ${context.cwd}`,
    "Use the runtime capabilities and skills that are available in this thread.",
    "</sofia_context>",
  ].join("\n");
}

/**
 * Read a project's AGENTS.md-style instructions to embed in the thread context.
 * Returns null when absent or unreadable. Only reads the top-level AGENTS.md /
 * CLAUDE.md to avoid chasing nested configs.
 */
export function readProjectInstructions(cwd: string): string | null {
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    const file = join(cwd, name);
    try {
      if (existsSync(file)) {
        const raw = readFileSync(file, "utf8").trim();
        return raw ? raw.slice(0, 8_000) : null;
      }
    } catch {
      // Best-effort.
    }
  }
  return null;
}
