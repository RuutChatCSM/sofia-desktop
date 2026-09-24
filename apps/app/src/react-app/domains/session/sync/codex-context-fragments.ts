// Codex composes the *model-facing* user message by prepending context
// fragments (skills, plugins, AGENTS.md, environment). `codex exec`/CLI
// rollouts persist those messages verbatim, so a legacy task's transcript opens
// with a wall of injected context as if the user had typed it. The TUI renders
// the turn's own user text, so the transcript must drop the same fragments.

/** Tags codex wraps around the context it prepends to a user message. */
const CONTEXT_BLOCK_NAMES = [
  "skills_instructions",
  "permissions instructions",
  "recommended_plugins",
  "plugins_instructions",
  "user_instructions",
  "INSTRUCTIONS",
  "environment_context",
  "recovered_thread_context",
];

const LEADING_CONTEXT_BLOCK = new RegExp(
  `^\\s*<(${CONTEXT_BLOCK_NAMES.join("|")})>[\\s\\S]*?<\\/\\1>\\s*`,
);
const AGENTS_MD_HEADER = /^\s*#\s*AGENTS\.md instructions for [^\n]*\n+/;

/**
 * Remove the context codex prepends to a user message, leaving only what the
 * user actually wrote. A message that was context only collapses to an empty
 * string so callers can skip it instead of rendering an empty bubble.
 */
export function stripInjectedCodexContext(text: string): string {
  let remaining = text;
  for (;;) {
    const stripped = remaining.replace(AGENTS_MD_HEADER, "").replace(LEADING_CONTEXT_BLOCK, "");
    if (stripped === remaining) return remaining.trim();
    remaining = stripped;
  }
}
