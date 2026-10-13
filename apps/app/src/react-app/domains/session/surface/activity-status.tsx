/** @jsxImportSource react */
import * as React from "react";
import { Minimize2, Sparkles, SquareTerminal } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { BackgroundProcess } from "@/app/lib/codex-session";
import {
  activityTitleForCommand,
  runningActivities,
  shouldSurfaceActivity,
  type Activity,
} from "@/react-app/domains/session/activity";
import {
  cleanBackgroundProcesses,
  refreshBackgroundProcesses,
  terminateBackgroundProcess,
  useBackgroundProcesses,
} from "@/react-app/domains/session/codex-session-store";
import { useSessionActivities } from "@/react-app/domains/session/use-session-activities";

/**
 * The persistent "work that outlives the turn" strip, fused to the top of the
 * composer like the plan (TodoPanel) and the queued/steer row. Same pattern: a
 * full-width header on the panel's own border that expands in place — never a
 * detached chip opening a side sheet.
 *
 * While a turn is visibly streaming the transcript already carries the current
 * activity ("✦ Running the app tests"), so this stays hidden; a second copy
 * beside the Stop button only makes the app read like a process manager. It
 * appears once the turn is done and something is *still* running.
 *
 * Only genuinely live resources may raise it (see `shouldSurfaceActivity`). A
 * process that completed or failed is history: the failure is attention, which
 * is the attention feed's job — not a chip claiming "Needs you" while nothing
 * is running. That is why the strip has no failure presentation at all.
 *
 * It reads Activities, never raw resources: the semantic operation is the title
 * and the terminal is the detail.
 */
export function ActivityStatus({ sessionId, turnActive = false }: { sessionId: string; turnActive?: boolean }) {
  const activities = useSessionActivities(sessionId);
  const processes = useBackgroundProcesses(sessionId);
  const [expanded, setExpanded] = React.useState(false);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [stoppingAll, setStoppingAll] = React.useState(false);

  React.useEffect(() => {
    // Reconcile on session change *and* when the turn ends: a process that
    // exited without emitting an exit item would otherwise leave the client
    // showing a stale "running" resource (the server reconciles it against the
    // engine's live list on this request).
    void refreshBackgroundProcesses(sessionId);
  }, [sessionId, turnActive]);

  const stop = React.useCallback(async (processId: string, itemId: string) => {
    setBusyId(itemId);
    try {
      await terminateBackgroundProcess(sessionId, processId || itemId);
    } finally {
      setBusyId(null);
    }
  }, [sessionId]);

  const stopAll = React.useCallback(async () => {
    setStoppingAll(true);
    try {
      await cleanBackgroundProcesses(sessionId);
    } finally {
      setStoppingAll(false);
    }
  }, [sessionId]);

  return (
    <ActivityStrip
      activities={activities}
      processes={processes}
      turnActive={turnActive}
      expanded={expanded}
      busyId={busyId}
      stoppingAll={stoppingAll}
      onToggle={() => setExpanded((value) => !value)}
      onStop={(processId, itemId) => void stop(processId, itemId)}
      onStopAll={() => void stopAll()}
    />
  );
}

export type ActivityStripProps = {
  activities: Activity[];
  processes: BackgroundProcess[];
  turnActive: boolean;
  expanded: boolean;
  busyId: string | null;
  stoppingAll: boolean;
  onToggle: () => void;
  onStop: (processId: string, itemId: string) => void;
  onStopAll: () => void;
};

/**
 * The presentation, free of the store: a live process is the only thing that
 * may mount it, and the header is the whole surface until the user expands it.
 */
export function ActivityStrip({
  activities,
  processes,
  turnActive,
  expanded,
  busyId,
  stoppingAll,
  onToggle,
  onStop,
  onStopAll,
}: ActivityStripProps) {
  if (!shouldSurfaceActivity(activities, turnActive)) return null;
  const running = runningActivities(activities);
  const current = running[0];
  if (!current) return null;
  const runningProcesses = processes.filter((process) => process.status === "running");
  const extra = running.length > 1 ? ` +${running.length - 1}` : "";

  return (
    <div className="overflow-hidden border-b border-dls-border bg-transparent" data-testid="activity-status">
      <button
        type="button"
        aria-expanded={expanded}
        title={current.title}
        className="flex w-full items-center justify-between px-4 py-3 text-xs text-gray-9 transition-colors hover:bg-gray-2/50"
        onClick={onToggle}
      >
        <span className="flex min-w-0 items-center gap-2">
          <Sparkles className="size-3 shrink-0 text-gray-11" aria-hidden="true" />
          <span className="truncate font-medium text-gray-11 ow-text-shimmer">
            {current.title}
            {extra}
          </span>
        </span>
        <Minimize2 size={12} className={cn("shrink-0 text-gray-8 transition-transform", expanded ? "" : "rotate-180")} />
      </button>
      {expanded ? (
        <div className="max-h-60 space-y-2.5 overflow-auto border-t border-dls-border px-4 pt-3 pb-3">
          {runningProcesses.map((process) => (
            <div key={process.itemId} className="rounded-lg border border-dls-border bg-dls-surface-muted/40 p-3" data-testid="background-process-row">
              <div className="flex items-start gap-2">
                <SquareTerminal className="mt-0.5 size-3.5 shrink-0 text-gray-9" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium text-gray-12">
                    {activityTitleForProcess(running, process)}
                  </div>
                  <code className="mt-0.5 block truncate font-mono text-[11px] text-gray-10">{process.command}</code>
                  {process.cwd ? <div className="truncate text-[11px] text-gray-9">{process.cwd}</div> : null}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busyId === process.itemId}
                  onClick={() => onStop(process.processId, process.itemId)}
                >
                  {busyId === process.itemId ? "Stopping..." : "Stop"}
                </Button>
              </div>
              {process.aggregatedOutput?.trim() ? (
                <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-dls-canvas/60 p-2 font-mono text-[11px] leading-5 text-gray-10">
                  {process.aggregatedOutput.trim()}
                </pre>
              ) : null}
            </div>
          ))}
          {runningProcesses.length > 1 ? (
            <div className="flex justify-end">
              <Button variant="outline" size="sm" disabled={stoppingAll} onClick={onStopAll}>
                {stoppingAll ? "Stopping all..." : "Stop all"}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The Activity is authoritative ("Running the app tests"); the command is only
 * the fallback for a live process the derivation has not named yet.
 */
function activityTitleForProcess(activities: Activity[], process: BackgroundProcess): string {
  const match = activities.find((activity) =>
    activity.resources.some(
      (resource) =>
        resource.type === "background_process" &&
        (resource.processId === process.processId || resource.processId === process.itemId),
    ),
  );
  return match?.title ?? activityTitleForCommand(process.command, process.title);
}
