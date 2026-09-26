/**
 * Which session-level messages are product copy, and how loud each one should be.
 *
 * Evaluator and continuation chatter is diagnostics, not product copy. "Goal not
 * satisfied — continuing: The agent's final message announces…" reads like a
 * fault the user caused, and it is meaningless outside a trace viewer. The
 * runtime still uses it to decide to keep working; normal mode simply does not
 * render it. Genuinely actionable engine warnings — a task held by another Sofia
 * process, a transcript that failed to load — always pass through.
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

/**
 * How much attention a notice deserves.
 *
 *   info    — the session is healthy; say it quietly and get out of the way
 *   warning — something is degraded and the user may need to act
 *
 * Hard failures are deliberately not on this ladder: a turn that cannot proceed
 * is rendered by the session-error surface, not by the notice strip, so there is
 * exactly one place a failure can appear.
 */
export type SessionNoticeKind = "info" | "warning";

export type SessionNotice = {
  kind: SessionNoticeKind;
  message: string;
  /** An action the notice can offer inline, if the app can perform it. */
  action?: "new-chat";
};

/**
 * The long-thread advisory the engine sends once a conversation has had to be
 * compacted — which is exactly the point at which the advice becomes true.
 *
 * Recognised by meaning rather than by equality, because the wording has already
 * varied ("threads" in core, "conversations" in the exec reporter). The sentence
 * is the engine's to write; the app only decides how loudly to say it, so the text
 * passes through unchanged. Anything not recognised stays a warning, which is the
 * safe default: an unknown warning must not be quietly demoted.
 */
const LONG_THREAD_PATTERNS: RegExp[] = [
  /long\s+threads?\s+and\s+multiple\s+compactions/i,
  /long\s+conversations?\s+and\s+multiple\s+compactions/i,
];

export function isLongThreadAdvisory(message: string): boolean {
  const text = message.trim();
  if (!text) return false;
  return LONG_THREAD_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * The notice to show in normal mode, or null when there is nothing to show.
 *
 * Developer mode additionally reveals evaluator/continuation diagnostics; the
 * advisory is shown either way, since it is product copy rather than a trace.
 */
export function sessionNotice(
  message: string | null | undefined,
  developerMode: boolean,
): SessionNotice | null {
  const text = message?.trim();
  if (!text) return null;
  if (isLongThreadAdvisory(text)) {
    return { kind: "info", message: text, action: "new-chat" };
  }
  if (!developerMode && isEvaluatorTraceWarning(text)) return null;
  return { kind: "warning", message: text };
}
