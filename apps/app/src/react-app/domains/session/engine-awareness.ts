import type { AgentEngine } from "./engine-selection-store";

/** True when the id names a codex-engine (Sofia) session. */
export function isCodexSessionId(sessionId: string | null | undefined): boolean {
  return typeof sessionId === "string" && sessionId.startsWith("codex-");
}

/**
 * Whether the codex-engine hooks must be active.
 *
 * The workspace's selected engine normally decides, but opening a `codex-*`
 * session must activate the codex path even when the selected engine is
 * `opencode` — otherwise the codex transcript is never mirrored/restored and
 * the session view renders empty (while the sidebar, fed by the codex session
 * list, still shows the title).
 */
export function shouldActivateCodexEngine(
  selectedEngine: AgentEngine,
  activeSessionId: string | null | undefined,
): boolean {
  return selectedEngine === "codex" || isCodexSessionId(activeSessionId);
}
