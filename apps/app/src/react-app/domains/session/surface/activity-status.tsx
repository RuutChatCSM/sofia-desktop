/** @jsxImportSource react */
import * as React from "react";
import { ChevronRight, Sparkles, SquareTerminal } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import {
  activityStatusLabel,
  activityTitleForStatus,
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
 * The persistent "work that outlives the turn" surface, above the composer.
 *
 * While a turn is visibly streaming the transcript already carries the current
 * activity ("✦ Running the app tests"), so this stays hidden — a second copy
 * next to the Stop button only makes the app read like a process manager. It
 * appears once the turn is done and something is *still* running.
 *
 * It reads Activities, never raw resources: the semantic operation first, and
 * the terminal beneath Details. The drawer is titled by the object (Activity),
 * not by its state (Running).
 */
export function ActivityStatus({ sessionId, turnActive = false }: { sessionId: string; turnActive?: boolean }) {
  const activities = useSessionActivities(sessionId);
  const processes = useBackgroundProcesses(sessionId);
  // Only a genuinely live resource may raise this surface (see
  // shouldSurfaceActivity): completed and failed processes are history.
  const current = shouldSurfaceActivity(activities, turnActive) ? runningActivities(activities)[0] ?? null : null;
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [stoppingAll, setStoppingAll] = React.useState(false);

  React.useEffect(() => {
    // Reconcile on session change *and* when the turn ends: a process that
    // exited without emitting an exit item would otherwise leave the client
    // showing a stale "running" resource (the server reconciles it against the
    // engine's live list on this request).
    void refreshBackgroundProcesses(sessionId);
  }, [sessionId, turnActive]);

  if (!current) return null;

  const running = runningActivities(activities);
  const runningProcesses = processes.filter((process) => process.status === "running");
  const extra = running.length > 1 ? ` +${running.length - 1}` : "";

  const stop = async (processId: string, itemId: string) => {
    setBusyId(itemId);
    try {
      await terminateBackgroundProcess(sessionId, processId || itemId);
    } finally {
      setBusyId(null);
    }
  };

  const stopAll = async () => {
    setStoppingAll(true);
    try {
      await cleanBackgroundProcesses(sessionId);
    } finally {
      setStoppingAll(false);
    }
  };

  return (
    <Sheet>
      <SheetTrigger
        title={activityTitleForStatus(current)}
        aria-label={activityTitleForStatus(current)}
        data-activity-status={current.status}
        className="mx-3 mb-2 flex w-fit max-w-[calc(100%-1.5rem)] items-center gap-2 rounded-lg border border-border/70 bg-muted/40 px-3 py-1.5 text-left text-[11px] text-muted-foreground hover:bg-muted/60 focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
      >
        <Sparkles className="size-3 shrink-0 text-foreground/70" aria-hidden="true" />
        <span className="truncate font-medium ow-text-shimmer">
          {activityTitleForStatus(current)}
          {extra}
        </span>
      </SheetTrigger>
      <SheetContent side="right" className="w-full sm:max-w-[380px]">
        <SheetHeader>
          <SheetTitle>Activity</SheetTitle>
          <SheetDescription>
            Work Sofia is doing in this task. It keeps going after the turn ends.
          </SheetDescription>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 pb-2">
          <div className="flex flex-col gap-3">
            {withCurrent(running, current).map((activity) => (
              <ActivityRow key={activity.id} activity={activity} />
            ))}
          </div>
          <div className="border-t border-border/70" />
          <Collapsible>
            <CollapsibleTrigger className="group flex w-full cursor-pointer items-center justify-between text-left text-[10px] uppercase tracking-wide text-muted-foreground/70 transition-colors hover:text-foreground">
              Details
              <ChevronRight
                aria-hidden="true"
                className="size-3.5 transition-transform duration-150 group-data-panel-open:rotate-90"
              />
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-3 flex flex-col gap-3">
              {runningProcesses.map((process) => {
                const output = process.aggregatedOutput?.trim() ?? "";
                return (
                  <div
                    key={process.itemId}
                    className="rounded-lg border border-border/70 bg-muted/30 p-3"
                    data-testid="background-process-row"
                  >
                    <div className="flex items-start gap-2">
                      <SquareTerminal className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                      <div className="min-w-0 flex-1">
                        <div className="text-[10px] uppercase tracking-wide text-muted-foreground/70">Terminal</div>
                        <code className="block truncate font-mono text-[12px] text-foreground/90">{process.command}</code>
                        {process.cwd ? (
                          <div className="truncate text-[11px] text-muted-foreground">{process.cwd}</div>
                        ) : null}
                        <div className="mt-0.5 text-[11px] text-emerald-11">Running</div>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busyId === process.itemId}
                        onClick={() => void stop(process.processId, process.itemId)}
                      >
                        {busyId === process.itemId ? "Stopping..." : "Stop"}
                      </Button>
                    </div>
                    {output ? (
                      <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-background/60 p-2 font-mono text-[11px] leading-5 text-muted-foreground">
                        {output}
                      </pre>
                    ) : null}
                  </div>
                );
              })}
              {runningProcesses.length === 0 ? (
                <p className="text-[12px] text-muted-foreground">Nothing is running right now.</p>
              ) : null}
            </CollapsibleContent>
          </Collapsible>
        </div>
        {/* "Stop all" is for several resources. One process already has its own
            Stop, so a permanent footer would just be chrome. */}
        {runningProcesses.length > 1 ? (
          <SheetFooter>
            <Button variant="outline" disabled={stoppingAll} onClick={() => void stopAll()}>
              {stoppingAll ? "Stopping all..." : "Stop all"}
            </Button>
          </SheetFooter>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function withCurrent(visible: Activity[], current: Activity): Activity[] {
  return visible.some((activity) => activity.id === current.id) ? visible : [current, ...visible];
}

function ActivityRow({ activity }: { activity: Activity }) {
  const failed = activity.status === "failed";
  return (
    <div data-testid="activity-row">
      <div className="text-[13px] font-medium text-foreground">{activityTitleForStatus(activity)}</div>
      <div className={cn("mt-0.5 flex items-center gap-1.5 text-[11px]", failed ? "text-amber-11" : "text-muted-foreground")}>
        <span
          className={cn("size-1.5 rounded-full", failed ? "bg-amber-11" : activity.status === "running" ? "bg-emerald-11" : "bg-muted-foreground/60")}
          aria-hidden="true"
        />
        {activityStatusLabel(activity.status)}
      </div>
    </div>
  );
}
