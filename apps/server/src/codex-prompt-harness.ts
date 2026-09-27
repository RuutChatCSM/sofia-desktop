// Sofia prompt harness: builds the small Sofia-specific developer context
// added to every new thread. The engine keeps ownership of its base prompt,
// project-instruction discovery, skills, and normal Sofia behavior.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type PromptHarnessContext = {
  workspaceId: string;
  cwd: string;
};

/** Give the engine Sofia host context and one concise capability-routing rule. */
export function buildSofiaDeveloperInstructions(context: PromptHarnessContext): string {
  return [
    "<sofia_context>",
    "Sofia is running this thread and displaying it in the Sofia app.",
    `Workspace id: ${context.workspaceId}`,
    `Working directory: ${context.cwd}`,
    "Infer the needed capability from the user's task; they do not need to name a tool or plugin. Consider built-in tools, enabled MCP servers, apps, plugin-provided tools, and local or Cloud skills. If a relevant tool is not directly visible, use tool_search when available before concluding it is unavailable. Use only capabilities confirmed callable in this turn, and report a missing or failed connection rather than guessing.",
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
