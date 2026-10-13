import { useCodexSessionStore } from "../../apps/app/src/react-app/domains/session/codex-session-store";
import { expect } from "vitest";
import { test } from "@sofia/testkit";
import { finishedTurnDurationMs, turnWorkLabel, turnWorkOutcome, formatTurnWorkDuration } from "../../apps/app/src/components/chat/turn-timing.ts";

const formatDuration = (ms: number) => `${Math.floor(ms / 1000)}s`;

test("work status distinguishes unknown, paused and explicitly stopped activity", () => {
  const input = { isLive: false, durationMs: null, formatDuration };
  expect(turnWorkLabel(input)).toBe("Activity");
  expect(turnWorkLabel({ ...input, isLive: true })).toBe("Working");
  expect(turnWorkLabel({ ...input, isLive: true, activeLabel: "Reading files" })).toBe("Working");
  expect(turnWorkLabel({ ...input, status: "paused", isLive: true })).toBe("Paused");
  expect(turnWorkLabel({ ...input, status: "stopped" })).toBe("You stopped");
  expect(turnWorkLabel({ ...input, durationMs: 3200, status: "stopped" })).toBe("You stopped after 3s");
  expect(turnWorkLabel({ ...input, durationMs: 3200 })).toBe("Worked for 3s");
});

test("a saved work duration remains unknown without both timestamps and never goes negative", () => {
  expect(finishedTurnDurationMs({ startedAt: 10, completedAt: null })).toBeNull();
  expect(finishedTurnDurationMs({ startedAt: null, completedAt: 10 })).toBeNull();
  expect(finishedTurnDurationMs({ startedAt: 20, completedAt: 10 })).toBe(0);
  expect(finishedTurnDurationMs({ startedAt: 10, completedAt: 40 })).toBe(30);
});


test("only explicit cancelled outcomes mark a work block stopped", () => {
  const message = (outcome?: string) => ({ id: "assistant", role: "assistant" as const, parts: [], metadata: { engine: { ...(outcome ? { turnOutcome: outcome } : {}) } } });
  expect(turnWorkOutcome([message()])).toBeUndefined();
  expect(turnWorkOutcome([message("cancelled")])).toBe("stopped");
  expect(turnWorkOutcome([message("failed")])).toBe("failed");
  expect(turnWorkOutcome([message("cancelled"), message("completed")])).toBeUndefined();
  expect(turnWorkLabel({ isLive: false, durationMs: 3000, status: "failed", formatDuration })).toBe("Activity");
});


test("completion preserves explicit outcome on its own turn without completing another turn", () => {
  const store = useCodexSessionStore.getState();
  const sessionId = 'work-outcome-proof';
  store.upsertSession({ id:sessionId,threadId:'thread',title:'Fixture',workspaceId:'fixture',created:'2026-10-10',status:'running',turnId:'current' });
  try {
    for (const turnId of ['earlier','current']) {
      store.upsertItem(sessionId,{id:turnId,type:'reasoning',turnId,item:{type:'reasoning',id:turnId},text:'',thinking:'Displayed summary',output:'',status:'pending'});
    }
    store.completeTurn(sessionId,'cancelled');
    const items = useCodexSessionStore.getState().sessions[sessionId].items;
    expect(items.find(item=>item.turnId==='current')).toMatchObject({status:'done',turnOutcome:'cancelled'});
    expect(items.find(item=>item.turnId==='earlier')).toMatchObject({status:'pending'});
    expect(items.find(item=>item.turnId==='earlier')?.turnOutcome).toBeUndefined();
  } finally { store.clear(); }
});


test("shipped work headings use elapsed whole seconds and omit zero duration units", () => {
  expect(formatTurnWorkDuration(700)).toBe('0s');
  expect(formatTurnWorkDuration(2800)).toBe('2s');
  expect(formatTurnWorkDuration(60000)).toBe('1m');
  expect(formatTurnWorkDuration(3661000)).toBe('1h 1m 1s');
  expect(formatTurnWorkDuration(86400000)).toBe('1d');
  expect(turnWorkLabel({isLive:true,elapsedMs:999,durationMs:null,formatDuration:formatTurnWorkDuration})).toBe('Working');
  expect(turnWorkLabel({isLive:true,elapsedMs:2800,durationMs:null,formatDuration:formatTurnWorkDuration})).toBe('Working for 2s');
});
