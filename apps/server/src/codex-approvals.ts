// Codex approval bridge: connects codex engine approval requests to the shared
// ApprovalService modal flow (GET /approvals + POST /approvals/:id). When a
// codex approval request arrives we create an ApprovalService entry; the user
// responds via the existing modal, and we translate the reply back to a codex
// decision via CodexSessionManager.respondApproval.
import type { ApprovalService } from "./approvals.js";
import type { CodexSessionManager } from "./codex-sessions.js";

const APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
]);

function approvalSummary(params: unknown): { summary: string; action: string } {
  const p = (params ?? {}) as Record<string, unknown>;
  const command = typeof p.command === "string" ? p.command : "";
  if (command) return { summary: `Sofia wants to run: ${command}`, action: "codex.command_execution" };
  const reason = typeof p.reason === "string" ? p.reason : "";
  if (reason) return { summary: `Sofia needs approval: ${reason}`, action: "codex.approval" };
  return { summary: "Sofia requests approval", action: "codex.approval" };
}

export function bridgeCodexApprovals(
  manager: CodexSessionManager,
  approvals: ApprovalService,
  workspaceId: string,
): () => void {
  return manager.on((event) => {
    if (event.type !== "approval.requested") return;
    const method = (event as { method?: string }).method;
    if (!method || !APPROVAL_METHODS.has(method)) return;
    const requestId = (event as { requestId?: string | number }).requestId;
    if (requestId === undefined) return;
    const { summary, action } = approvalSummary(event.params);
    const params = event.params as { permissions?: Record<string, unknown> } | null;
    const permissions = params?.permissions;
    // Fire-and-forget; the ApprovalService resolves when the user responds.
    approvals
      .requestApproval({
        workspaceId,
        action,
        summary: permissions ? `${summary}\n${JSON.stringify(permissions, null, 2)}` : summary,
        paths: [],
        actor: { type: "host" },
      })
      .then((result) => {
        manager.respondApproval(requestId, result.allowed ? "Accept" : "Decline", method, permissions);
      })
      .catch(() => {
        manager.respondApproval(requestId, "Decline", method);
      });
  });
}
