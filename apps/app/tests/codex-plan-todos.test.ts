import { afterEach, describe, expect, test } from "bun:test";

import { createCodexSessionClient } from "../src/app/lib/codex-session";
import { useCodexSessionStore } from "../src/react-app/domains/session/codex-session-store";
import { restoreCodexSessionItems, syncCodexTranscriptToCache } from "../src/react-app/domains/session/sync/codex-transcript-adapter";
import { todoKey } from "../src/react-app/domains/session/sync/session-sync";
import { getReactQueryClient } from "../src/react-app/infra/query-client";

const WORKSPACE = "ws_plan";
const SESSION = "codex-plan-1";
const originalFetch = globalThis.fetch;

function seedSession(threadId: string, status: "idle" | "running"): void {
  useCodexSessionStore.getState().upsertSession({
    id: SESSION, threadId, title: "Plan task", workspaceId: WORKSPACE,
    created: "2026-01-01", turnId: null, status,
  });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  getReactQueryClient().clear();
  useCodexSessionStore.getState().clear();
});

// Codex's `update_plan` checklist arrives as a `turn/plan/updated` notification,
// not an item, so it is mirrored into the same todo cache the engine's
// `todowrite` tool feeds — which is what the session checklist panel reads.
describe("codex update_plan checklist", () => {
  test("mirrors the plan into the shared todo cache the checklist panel reads", () => {
    seedSession("plan-1", "running");
    useCodexSessionStore.getState().setPlan(SESSION, [
      { step: "Read the README", status: "in_progress" },
      { step: "Check the commands", status: "completed" },
      { step: "Report findings", status: "pending" },
    ]);

    syncCodexTranscriptToCache(WORKSPACE, SESSION);

    expect(getReactQueryClient().getQueryData(todoKey(WORKSPACE, SESSION))).toEqual([
      { id: "plan-0", content: "Read the README", status: "in_progress", priority: "medium" },
      { id: "plan-1", content: "Check the commands", status: "completed", priority: "medium" },
      { id: "plan-2", content: "Report findings", status: "pending", priority: "medium" },
    ]);
  });

  test("leaves the todo cache untouched until a plan arrives", () => {
    seedSession("plan-2", "idle");

    syncCodexTranscriptToCache(WORKSPACE, SESSION);

    expect(getReactQueryClient().getQueryData(todoKey(WORKSPACE, SESSION))).toBeUndefined();
  });

  test("restores a persisted plan when a task is reopened", async () => {
    seedSession("plan-3", "idle");
    const client = createCodexSessionClient({ baseUrl: "http://127.0.0.1:1", token: "token", workspaceId: WORKSPACE });
    globalThis.fetch = async () => new Response(
      JSON.stringify({ ok: true, items: [], changes: [], plan: [
        { step: "Restored step", status: "completed" },
        { step: "Still open", status: "in_progress" },
      ] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

    await restoreCodexSessionItems(client, WORKSPACE, SESSION);

    expect(getReactQueryClient().getQueryData(todoKey(WORKSPACE, SESSION))).toEqual([
      { id: "plan-0", content: "Restored step", status: "completed", priority: "medium" },
      { id: "plan-1", content: "Still open", status: "in_progress", priority: "medium" },
    ]);
  });
});
