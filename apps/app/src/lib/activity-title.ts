// Presentation-only naming for Activities.
//
// A resource (a background process today; browser tabs, tool calls, artifacts
// later) is never the activity itself. The activity is the user-facing
// operation, so its title is a short generic phrase — never a tool name, never
// a raw command line. When the orchestrator knows *why* it ran something, its
// own words win; reading the command is only the fallback.

/** Unwrap `/bin/zsh -lc '<command>'` so we classify the command, not the shell. */
export function stripShellWrapper(command: string): string {
  const match = /^(?:.*\/)?(?:zsh|bash|sh|fish)\b[^'"]*?(['"])([\s\S]*)\1$/.exec(command.trim());
  return (match ? match[2] : command).trim();
}

const TEST_RUNNER = /\b(?:vitest|jest|pytest|playwright|cypress)\b/i;
const PACKAGE_TEST = /\b(?:pnpm|npm|yarn|bun|npx)\b[^&|;]*\btest\b/i;
const LANGUAGE_TEST = /\b(?:cargo|go|dotnet|mvn|gradle)\b[^&|;]*\btest\b/i;
const DEV_RUNNER = /\b(?:vite|next\s+dev|nuxt\s+dev|webpack\s+serve|nodemon|uvicorn|gunicorn|flask\s+run|rails\s+s(?:erver)?)\b/i;
const PACKAGE_DEV = /\b(?:pnpm|npm|yarn|bun|npx)\b[^&|;]*\b(?:dev|develop|serve)\b/i;
const PACKAGE_BUILD = /\b(?:pnpm|npm|yarn|bun|npx)\b[^&|;]*\bbuild\b/i;
const LANGUAGE_BUILD = /\b(?:tsc|webpack|make|cargo\s+build|go\s+build|dotnet\s+build|next\s+build)\b/i;
const PACKAGE_FILTER = /--filter[= ]\s*(\S+)/;

/** `@sofia/app` → `app`, `apps/web` → `web`: the noun a person would say. */
function packageNoun(filter: string): string {
  return filter.split("/").filter(Boolean).pop() ?? filter;
}

/**
 * The user-visible operation for a command. `semanticTitle` (the orchestrator's
 * own words, e.g. "Running the app tests") takes precedence; the command is
 * only parsed when nothing better is known.
 */
export function activityTitleForCommand(command: string, semanticTitle?: string): string {
  const explicit = semanticTitle?.trim();
  if (explicit) return explicit;

  const raw = stripShellWrapper(command).replace(/\s+/g, " ").trim();
  if (!raw) return "Running a task";

  if (TEST_RUNNER.test(raw) || PACKAGE_TEST.test(raw) || LANGUAGE_TEST.test(raw)) {
    const filter = PACKAGE_FILTER.exec(raw);
    const noun = filter ? packageNoun(filter[1]) : "";
    return noun ? `Running the ${noun} tests` : "Running tests";
  }
  if (DEV_RUNNER.test(raw) || PACKAGE_DEV.test(raw)) return "Running the dev server";
  if (PACKAGE_BUILD.test(raw) || LANGUAGE_BUILD.test(raw)) return "Building the project";

  const short = raw.length > 48 ? `${raw.slice(0, 47)}…` : raw;
  return `Running ${short}`;
}
