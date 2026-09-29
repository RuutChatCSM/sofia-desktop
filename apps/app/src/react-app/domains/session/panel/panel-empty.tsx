/** @jsxImportSource react */
import * as React from "react";
import { ArrowLeft, ArrowRight, FileText, Globe, Mic2, Puzzle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type PanelEmptyActions = {
  onNavigate?: (url: string) => void;
  recentPages?: Array<{ id: string; label: string; url: string }>;
  onSelectRecent?: (id: string) => void;
  onOpenFiles?: () => void;
  onOpenBrowser?: () => void;
  onOpenExtensions?: () => void;
  onOpenVoice?: () => void;
};

export function handlePanelEscape(key: string, onClose: () => void) {
  if (key !== "Escape") return false;
  onClose();
  return true;
}

type PanelDestination = {
  id: "browser" | "files" | "extensions" | "voice";
  label: string;
  description: string;
  icon: React.ReactNode;
  activate: () => void;
};

export function getPanelDestinations(
  actions: PanelEmptyActions,
  onOpenFiles: () => void,
): PanelDestination[] {
  const destinations: PanelDestination[] = [];

  if (actions.onOpenBrowser) {
    destinations.push({
      id: "browser",
      label: "Browser",
      description: "Open a new page in the built-in browser.",
      icon: <Globe aria-hidden="true" />,
      activate: actions.onOpenBrowser,
    });
  }

  destinations.push({
    id: "files",
    label: "Files",
    description: "Browse and edit workspace files.",
    icon: <FileText aria-hidden="true" />,
    activate: onOpenFiles,
  });

  if (actions.onOpenExtensions) {
    destinations.push({
      id: "extensions",
      label: "Library",
      description: "Browse the skills and connections available to your agent.",
      icon: <Puzzle aria-hidden="true" />,
      activate: actions.onOpenExtensions,
    });
  }

  if (actions.onOpenVoice) {
    destinations.push({
      id: "voice",
      label: "Voice Mode",
      description: "Talk to Sofia with real-time voice.",
      icon: <Mic2 aria-hidden="true" />,
      activate: actions.onOpenVoice,
    });
  }

  return destinations;
}

export function PanelEmpty({ onNavigate, recentPages = [], onSelectRecent, onOpenFiles, onOpenBrowser, onOpenExtensions, onOpenVoice }: PanelEmptyActions) {
  const [address, setAddress] = React.useState("");
  const [destination, setDestination] = React.useState<"chooser" | "files">("chooser");

  if (destination === "files") {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4 sm:p-6">
        <Button
          variant="ghost"
          size="sm"
          className="mb-6 w-fit gap-2"
          onClick={() => setDestination("chooser")}
        >
          <ArrowLeft />
          All destinations
        </Button>
        <div className="m-auto max-w-sm text-center">
          <span className="mx-auto mb-4 flex size-11 items-center justify-center rounded-xl bg-muted text-muted-foreground">
            <FileText aria-hidden="true" />
          </span>
          <h2 className="text-base font-medium text-foreground">No files or artifacts yet</h2>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Files and artifacts created in this session will appear here automatically.
          </p>
        </div>
      </div>
    );
  }

  const destinations = getPanelDestinations(
    { onOpenBrowser, onOpenExtensions, onOpenVoice },
    onOpenFiles ?? (() => setDestination("files")),
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4 sm:p-6">
      {onNavigate ? <form className="mx-auto w-full max-w-3xl" onSubmit={(event) => {
        event.preventDefault();
        const value = address.trim();
        if (!value) return;
        onNavigate(/^(https?:\/\/|localhost[:/]|[\w-]+\.[\w.-]+([:/]|$))/i.test(value)
          ? /^https?:\/\//i.test(value) ? value : `${value.startsWith("localhost") ? "http" : "https"}://${value}`
          : `https://www.google.com/search?q=${encodeURIComponent(value)}`);
      }}><input aria-label="Search or enter a URL" placeholder="Search or enter a URL" className="w-full rounded-full bg-muted px-5 py-3 text-center text-sm outline-none focus:ring-1 focus:ring-ring" value={address} onChange={(event) => setAddress(event.target.value)} /></form> : null}
      <div className="mt-12 w-full max-w-3xl self-center">
        <h2 className="mb-2 px-2 text-xs font-medium text-muted-foreground">Tools</h2>
        <div className="grid gap-2 sm:grid-cols-2" aria-label="Panel destinations">
          {destinations.map((item) => (
            <button
              key={item.id}
              type="button"
              className={cn(
                "group flex min-h-10 w-full items-center gap-2.5 rounded-lg bg-muted/30 px-3 py-2 text-left",
                "transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              )}
              title={item.description}
              onClick={() => item.activate()}
            >
              <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-4">
                {item.icon}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-foreground">{item.label}</span>
                
              </span>
              <ArrowRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
            </button>
          ))}
        </div>
        {recentPages.length ? <div className="mt-10"><h2 className="mb-3 text-xs text-muted-foreground">Recent pages</h2>{recentPages.map((page) => <button type="button" key={page.id} className="flex w-full items-center gap-3 border-b border-border/50 px-3 py-3 text-left text-sm hover:bg-muted/30" onClick={() => onSelectRecent?.(page.id)}><Globe className="size-4" /><span className="min-w-0 truncate">{page.label}<span className="block truncate text-xs text-muted-foreground">{page.url}</span></span></button>)}</div> : null}
      </div>
    </div>
  );
}
