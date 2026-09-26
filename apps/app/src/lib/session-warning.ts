/**
 * Evaluator and continuation chatter is diagnostics, not product copy.
 *
 * "Goal not satisfied — continuing: The agent's final message announces…" reads
 * like a fault the user caused, and it is meaningless outside a trace viewer.
 * The runtime still uses it to decide to keep working; normal mode simply does
 * not render it. Genuinely actionable engine warnings — a task held by another
 * Sofia process, a transcript that failed to load — always pass through.
 */
const EVALUATOR_TRACE_PATTERNS: RegExp[] = [
  /\bgoal\s+not\s+satisfied\b/i,
  /\bcontinuing\s*:/i,
  /\bcontinuation\s+reason\b/i,
  /\bagent'?s\s+final\s+message\b/i,
  /\bauto-?continuation\b/i,
];

export function isEvaluatorTraceWarning(message: string): boolean {
  const text = message.trim();
  if (!text) return false;
  return EVALUATOR_TRACE_PATTERNS.some((pattern) => pattern.test(text));
}

/** The notice to show in normal mode, or null when it is diagnostics only. */
export function userFacingWarning(
  message: string | null | undefined,
  developerMode: boolean,
): string | null {
  const text = message?.trim();
  if (!text) return null;
  if (developerMode) return text;
  return isEvaluatorTraceWarning(text) ? null : text;
}
