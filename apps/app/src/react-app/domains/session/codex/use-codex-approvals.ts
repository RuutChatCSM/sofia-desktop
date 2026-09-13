"use client";

import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import type { CodexApprovalRequest, CodexSessionClient } from "@/app/lib/codex-session";
import { useCodexSessionStore } from "@/react-app/domains/session/codex-session-store";

/** The currently-pending codex engine approval for a workspace, if any. */
export type ActiveCodexApproval = { approval: CodexApprovalRequest; approve: () => Promise<void>; deny: () => Promise<void> } | null;

const EMPTY: CodexApprovalRequest[] = [];

/**
 * Poll the host ApprovalService for pending codex engine approvals and surface
 * the first one for the given workspace (allow/deny routes back to codex).
 * Refreshes whenever the codex stream reports a new approval.requested event.
 */
export function useCodexApprovals(client: CodexSessionClient | null, workspaceId: string): ActiveCodexApproval {
  const [pending, setPending] = useState<CodexApprovalRequest[]>(EMPTY);
  const [nonce, setNonce] = useState(0);

  // Trigger a refetch when the codex store emits a new approval event.
  useEffect(() => {
    const store = useCodexSessionStore.getState();
    let last = 0;
    const before = store.sessions;
    const unsub = useCodexSessionStore.subscribe(() => {
      const now = Date.now();
      if (now - last > 500) { last = now; setNonce((n) => n + 1); }
    });
    void before;
    return unsub;
  }, []);

  useEffect(() => {
    if (!client) { setPending(EMPTY); return; }
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await client.getApprovals();
        const items = (res.items ?? []).filter((a) => a.workspaceId === workspaceId && a.action.startsWith("codex."));
        if (!cancelled) setPending(items);
      } catch {
        if (!cancelled) setPending(EMPTY);
      }
    };
    void poll();
    const interval = setInterval(poll, 2500);
    return () => { cancelled = true; clearInterval(interval); };
  }, [client, workspaceId, nonce]);

  const approval = pending[0] ?? null;
  if (!approval || !client) return null;

  return {
    approval,
    approve: () => respond(client, approval.id, true),
    deny: () => respond(client, approval.id, false),
  };
}

async function respond(client: CodexSessionClient, id: string, allow: boolean) {
  await client.respondApproval(id, allow);
}

export function getApprovalAction(approval: CodexApprovalRequest): string {
  return approval.action || "codex.approval";
}
