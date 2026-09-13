"use client";

import { useEffect, useRef, useState } from "react";
import { Shield, ShieldCheck, ShieldAlert, ShieldX } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { CodexSessionClient } from "@/app/lib/codex-session";

export type ApprovalMode = "ask" | "approve" | "full";

const MODE_LABELS: Record<ApprovalMode, { title: string; description: string }> = {
  ask: { title: "Ask for approval", description: "Always ask before editing files, using the browser, or running commands." },
  approve: { title: "Approve for me", description: "Only ask for actions detected as potentially unsafe." },
  full: { title: "Full access", description: "Never ask — full access to the internet and your files." },
};

function modeIcon(mode: ApprovalMode) {
  if (mode === "full") return <ShieldCheck className="size-3.5 text-amber-600" aria-hidden />;
  if (mode === "approve") return <Shield className="size-3.5" aria-hidden />;
  return <ShieldX className="size-3.5" aria-hidden />;
}

/** Compact ChatGPT-style "How should actions be approved?" control for the
 * composer action row. A pill showing the current mode; clicking it opens the
 * Ask / Approve for me / Full access menu and writes the choice to the host. */
export function ApprovalModeSelector({ client }: { client: CodexSessionClient | null }) {
  const [mode, setMode] = useState<ApprovalMode>("ask");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    void client.getApprovalMode().then((res) => {
      if (!cancelled && (["ask", "approve", "full"] as string[]).includes(res.mode)) setMode(res.mode as ApprovalMode);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [client]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const select = async (next: ApprovalMode) => {
    if (!client || busy) return;
    setBusy(true);
    try {
      const res = await client.setApprovalMode(next);
      if (["ask", "approve", "full"].includes(res.mode)) setMode(res.mode as ApprovalMode);
      setOpen(false);
    } catch {
      // Keep the previous mode on failure.
    } finally {
      setBusy(false);
    }
  };

  return (
    <div ref={ref} className="relative">
      <Button variant="ghost" size="sm" className="gap-1 text-xs text-muted-foreground" disabled={!client || busy} onClick={() => setOpen((v) => !v)}>
        {modeIcon(mode)}
        {MODE_LABELS[mode].title}
      </Button>
      {open ? (
        <div className="absolute bottom-full right-0 z-50 mb-2 w-80 rounded-md border bg-background p-1.5 shadow-lg">
          <div className="flex items-center gap-1.5 px-2 py-1.5 text-xs font-medium text-muted-foreground">
            <ShieldAlert className="size-3.5" aria-hidden />
            How should actions be approved?
          </div>
          {(Object.keys(MODE_LABELS) as ApprovalMode[]).map((key) => (
            <div
              key={key}
              role="button"
              tabIndex={0}
              className="flex cursor-pointer items-start gap-2 rounded-sm px-2 py-2 hover:bg-muted/50"
              onClick={() => select(key)}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") select(key); }}
            >
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">
                  {MODE_LABELS[key].title}
                  {key === mode ? <span className="ml-1 text-current">✓</span> : null}
                </div>
                <div className="text-xs text-muted-foreground">{MODE_LABELS[key].description}</div>
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
