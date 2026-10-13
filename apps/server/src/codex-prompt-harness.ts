// Sofia prompt harness: builds the small Sofia-specific developer context
// added to every new thread. The engine keeps ownership of its base prompt,
// project-instruction discovery, skills, and normal Sofia behavior.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type PromptHarnessContext = {
  workspaceId: string;
  cwd: string;
};

/**
 * Shell-search guidance. The most common self-inflicted failure is an unquoted
 * glob: zsh expands `--include=*.ts` before rg ever runs and the command dies
 * with "no matches found", which then reads as "ripgrep is unusable" and the
 * agent falls back to grep. Say the quoting rule once, plainly.
 */
const SOFIA_SEARCH_GUIDANCE =
  "Search with ripgrep: `rg -g '*.ts' 'pattern' path` — always quote globs (an unquoted `*.ts` is expanded by the shell and fails with \"no matches found\"), and note `rg` filters with `-g`/`--glob`, not grep's `--include`. List files with `rg --files` (`-g '*.md'` to filter). Ripgrep returning no matches is an answer, not a reason to re-run it under grep.";

/** Give the engine Sofia host context and one concise capability-routing rule. */
export function buildSofiaDeveloperInstructions(context: PromptHarnessContext): string {
  return [
    "<sofia_context>",
    "Sofia is running this thread and displaying it in the Sofia app.",
    `Workspace id: ${context.workspaceId}`,
    `Working directory: ${context.cwd}`,
    "Infer the needed capability from the user's task; they do not need to name a tool or plugin. Consider built-in tools, enabled MCP servers, apps, plugin-provided tools, and local or Cloud skills. If a relevant tool is not directly visible, use tool_search when available before concluding it is unavailable. Use only capabilities confirmed callable in this turn, and report a missing or failed connection rather than guessing.",
    "When the user asks about an app already open on their computer, including Safari or a signed-in website, check the available computer-use tools and inspect that app before answering. An existing authenticated browser session can be observed through the app's visible UI when permissions allow; do not claim access is limited to public pages, or that all authenticated pages are inaccessible. Never extract cookies, passwords, or tokens to recreate a session. If the tool or macOS permission is unavailable, report that exact limitation.",
    "An app's Peek is a preview of that existing native app, not a request to open its URL in Sofia's browser. For Safari or another existing app, use computer-use to snapshot the app by name or pid without activating or focusing it; the user should be able to keep working in Sofia. Only bring the app foreground when the user explicitly asks to open it normally or clicks the preview.",
    "When callable subagent tools are available and the task has independent substantial parts, consider delegating scoped work while you continue the main task. Examples: frontend and server investigation; independent evidence gathering for competing approaches; a focused review of a completed change. Give each agent a descriptive task name, the actual brief, read/write limits, and the expected result. Use disjoint file ownership for parallel edits. Wait for required results, inspect their evidence, and integrate them before declaring completion. Keep simple edits, short questions, and tightly dependent steps in the main agent. Follow the user's preferences and project instructions; never claim an agent is running without a successful tool result.",
    SOFIA_SEARCH_GUIDANCE,
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
