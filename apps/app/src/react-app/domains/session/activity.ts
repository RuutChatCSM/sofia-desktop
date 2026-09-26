// Activity: a thin, user-facing presentation over runtime facts.
//
// Resources (background processes today; browser tabs, tool calls, artifacts,
// and remote work later) do the work, but the user reads *Activities*. Titles
// are intentionally generic ("Running tests", "Running the dev server") so the
// same surface reads naturally for a developer, a finance user, or an ops user
// — the terminal is a detail of the activity, never its name.
//
// This is a presentation model, not an orchestration layer: no Run hierarchy,
// no scheduling, no queueing yet.
import type { BackgroundProcess } from "@/app/lib/codex-session";
import { activityTitleForCommand } from "../../../lib/activity-title";

export { activityTitleForCommand, stripShellWrapper } from "../../../lib/activity-title";

export type ActivityKind = "work" | "analysis" | "research" | "artifact" | "browser" | "transfer";
export type ActivityStatus = "running" | "waiting" | "completed" | "failed";

export type ActivityResource =
  | { type: "background_process"; processId: string }
  | { type: "browser"; tabId: string }
  | { type: "tool"; toolCallId: string }
  | { type: "artifact"; artifactId: string };

export type Activity = {
  id: string;
  sessionId: string;
  runId?: string;
  /** Short, user-visible operation. Never reasoning, never a tool name. */
  title: string;
  kind: ActivityKind;
  status: ActivityStatus;
  progress?: { current?: number; total?: number; label?: string };
  resources: ActivityResource[];
};

export function activityStatusForProcess(process: BackgroundProcess): ActivityStatus {
  if (process.status === "running") return "running";
  if (process.status === "failed" || process.status === "declined") return "failed";
  if (process.status === "completed" && typeof process.exitCode === "number" && process.exitCode !== 0) {
    return "failed";
  }
  return "completed";
}

/**
 * A resource that stopped unexpectedly must not keep a "Running …" title: the
 * chip and the drawer have to agree with reality, so the outcome lives in the
 * title ("Tests failed", not "Running tests").
 */
export function activityTitleForStatus(activity: Activity): string {
  if (activity.status !== "failed") return activity.title;
  const base = activity.title.replace(/^Running\s+/i, "").trim() || activity.title;
  return `${base.charAt(0).toUpperCase()}${base.slice(1)} failed`;
}

/**
 * The state belongs *inside* the activity ("Activity › Running the app tests ›
 * ● Running"), so the words describe what the user is waiting on, not a
 * process state machine.
 */
export function activityStatusLabel(status: ActivityStatus): string {
  if (status === "running") return "Running";
  if (status === "waiting" || status === "failed") return "Needs you";
  return "Finished";
}

/**
 * One Activity per background process for now. When several resources belong to
 * one operation (or the agent supplies a semantic title), this is the single
 * place to group them — the UI reads Activities, never resources.
 */
export function deriveActivities(sessionId: string, processes: BackgroundProcess[]): Activity[] {
  return processes.map((process) => ({
    id: `background_process:${process.itemId}`,
    sessionId,
    title: activityTitleForCommand(process.command, process.title),
    kind: "work" as const,
    status: activityStatusForProcess(process),
    resources: [{ type: "background_process" as const, processId: process.processId || process.itemId }],
  }));
}

/** The activity to surface inline: running first, then a failure needing attention. */
export function currentActivity(activities: Activity[]): Activity | null {
  return activities.find((activity) => activity.status === "running")
    ?? activities.find((activity) => activity.status === "failed")
    ?? null;
}

/** Activities still running, in display order. */
export function runningActivities(activities: Activity[]): Activity[] {
  return activities.filter((activity) => activity.status === "running");
}

/**
 * The single live-progress line. An Activity is authoritative ("Running the app
 * tests"); the in-flight tool's own label is the fallback, and `null` means the
 * caller shows its generic "working…" text. One presenter, never two.
 */
export function liveActivityLabel(activities: Activity[], toolLabel: string | null): string | null {
  return runningActivities(activities)[0]?.title ?? toolLabel;
}

/**
 * The composer-adjacent surface is for work that *outlives the turn*. While a
 * turn is visibly streaming the transcript already carries the activity
 * ("✦ Running the app tests"), so a second copy there is just noise.
 *
 * It also requires a resource that is *genuinely still alive*. A process that
 * completed or failed is history — the agent already saw its output, and any
 * failure becomes session-level attention — so it must never leave a persistent
 * "Running …" chip behind. That is what produced the impossible
 * "Needs you" + "Nothing is running right now." panel.
 */
export function shouldSurfaceActivity(activities: Activity[], turnActive: boolean): boolean {
  return !turnActive && runningActivities(activities).length > 0;
}
