// Codex (Sofia) is the only agent engine. This module previously persisted a
// user-selectable engine and mirrored it to the desktop main process so it
// could choose whether to boot Sofia; Sofia has been removed, so the
// selection is now fixed.
export type AgentEngine = "codex";

export const DEFAULT_AGENT_ENGINE: AgentEngine = "codex";

export function useSelectedEngine(): AgentEngine {
  return DEFAULT_AGENT_ENGINE;
}
