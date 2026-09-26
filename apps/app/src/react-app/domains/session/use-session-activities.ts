/** @jsxImportSource react */
import { useMemo } from "react";

import { useBackgroundProcesses } from "./codex-session-store";
import { deriveActivities, type Activity } from "./activity";

const EMPTY_ACTIVITIES: Activity[] = [];

/** Activities for a session, derived from the runtime facts the store holds. */
export function useSessionActivities(sessionId: string): Activity[] {
  const processes = useBackgroundProcesses(sessionId);
  return useMemo(
    () => (processes.length ? deriveActivities(sessionId, processes) : EMPTY_ACTIVITIES),
    [sessionId, processes],
  );
}
