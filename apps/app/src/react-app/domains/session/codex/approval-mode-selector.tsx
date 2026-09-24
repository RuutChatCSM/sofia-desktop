"use client";

import { useEffect, useState } from "react";
import { Check, ChevronDown, LoaderCircle, Shield } from "lucide-react";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import type { CodexSessionClient } from "@/app/lib/codex-session";

export type ApprovalMode = "ask" | "approve" | "full";
const MODES: Array<{ mode: ApprovalMode; title: string; description: string }> = [
  { mode: "ask", title: "Ask for approval", description: "Work inside this project. Ask when an action needs additional permission." },
  { mode: "approve", title: "Approve for me", description: "Review connected-tool actions automatically. Ask when approval is still required." },
  { mode: "full", title: "Full access", description: "Access files and the internet without asking for approval." },
];
function isMode(value: string): value is ApprovalMode {
  return value === "ask" || value === "approve" || value === "full";
}

export function ApprovalModeSelector({ client }: { client: CodexSessionClient | null }) {
  const [mode, setMode] = useState<ApprovalMode | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setMode(null);
    setError(null);
    if (client) void client.getApprovalMode().then((res) => {
      if (!cancelled && isMode(res.mode)) setMode(res.mode);
    }).catch((error: unknown) => {
      if (!cancelled) setError(error instanceof Error ? error.message : "Could not load permissions.");
    });
    return () => { cancelled = true; };
  }, [client]);

  async function select(next: ApprovalMode) {
    if (!client || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await client.setApprovalMode(next);
      if (!isMode(result.mode)) throw new Error("Sofia returned an unknown permission mode.");
      setMode(result.mode);
      setOpen(false);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not change permissions. Try again.");
    } finally { setBusy(false); }
  }

  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger disabled={!client || busy} className="inline-flex min-h-9 items-center gap-1.5 rounded-lg px-2 text-xs text-dls-secondary transition-colors hover:bg-dls-hover focus-visible:ring-2 focus-visible:ring-dls-accent" aria-label="Task permissions">
      {busy ? <LoaderCircle className="size-3.5 motion-safe:animate-spin" /> : <Shield className="size-3.5" />}
      {MODES.find((entry) => entry.mode === mode)?.title ?? "Permissions"}
      <ChevronDown className="size-3" />
    </PopoverTrigger>
    <PopoverContent side="top" align="end" className="w-80 max-w-[calc(100vw-2rem)] gap-2 rounded-2xl p-2">
      <PopoverTitle className="px-2 pt-2 text-sm">Task permissions</PopoverTitle>
      <p className="px-2 text-xs text-dls-secondary">Applies to new turns. Stop running tasks before changing access.</p>
      <div role="group" aria-label="Permission modes">
        {MODES.map((entry) => <button key={entry.mode} type="button" disabled={busy} aria-pressed={mode === entry.mode} onClick={() => void select(entry.mode)} className="flex min-h-14 w-full items-start gap-3 rounded-xl p-3 text-left hover:bg-muted focus-visible:ring-2 focus-visible:ring-dls-accent disabled:opacity-50">
          <span className="flex-1"><span className="block text-sm font-medium">{entry.title}</span><span className="mt-1 block text-xs text-dls-secondary">{entry.description}</span></span>
          {mode === entry.mode ? <Check className="mt-1 size-4 shrink-0" /> : null}
        </button>)}
      </div>
      {error ? <p role="alert" className="rounded-xl bg-red-3 px-3 py-2 text-xs text-red-11">{error}</p> : null}
    </PopoverContent>
  </Popover>;
}
