// AgentEngine adapter seam: allows the server to treat Codex as one engine
// option alongside OpenCode without refactoring the existing opencode flow.
// Additive — existing OpencodeClient / engine-pool behavior untouched.
import { CodexSessionManager, createCodexSessionManager } from "./codex-sessions.js";
import type { CodexEngineHandle } from "./codex-sessions.js";

export interface AgentEngineHandle {
  kind: "opencode" | "codex";
  sessionManager?: CodexSessionManager;
  handle?: CodexEngineHandle;
}

export function createAgentEngine(kind: "codex", handle: CodexEngineHandle): AgentEngineHandle {
  const manager = createCodexSessionManager(handle);
  return { kind, sessionManager: manager, handle };
}

export async function startAgentEngine(engine: AgentEngineHandle): Promise<void> {
  if (engine.kind === "codex" && engine.sessionManager) {
    await engine.sessionManager.start();
  }
}
