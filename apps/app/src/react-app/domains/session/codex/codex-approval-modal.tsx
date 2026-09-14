"use client";

import { AlertTriangle, Check, X } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import type { ActiveCodexApproval } from "./use-codex-approvals";

/** ChatGPT-style codex approval prompt. Mirrors the app's "How should ChatGPT
 * actions be approved?" surface: shows the requested action and lets the user
 * Allow or Deny. Routes back to the codex engine via the host ApprovalService. */
export function CodexApprovalModal({ active }: { active: ActiveCodexApproval }) {
  if (!active) return null;
  const { approval, approve, deny } = active;

  const isOpen = Boolean(approval);
  const paths = approval.paths?.length ? approval.paths.slice(0, 3) : [];

  return (
    <AlertDialog open={isOpen}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <AlertTriangle className="size-4 text-amber-600" aria-hidden />
            Sofia needs approval
          </AlertDialogTitle>
          <AlertDialogDescription className="whitespace-pre-line">
            {approval.summary || approval.action || "Codex is requesting an action that needs your approval."}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {paths.length > 0 ? (
          <ul className="max-h-40 overflow-y-auto space-y-1 rounded-md border bg-muted/40 p-3 text-sm">
            {paths.map((path) => (
              <li key={path} className="truncate font-mono text-xs text-muted-foreground">
                {path}
              </li>
            ))}
          </ul>
        ) : null}

        <AlertDialogFooter>
          <AlertDialogCancel onClick={deny}>
            <X className="size-4" aria-hidden /> Deny
          </AlertDialogCancel>
          <AlertDialogAction onClick={approve}>
            <Check className="size-4" aria-hidden /> Allow
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
