import { afterEach, describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";

import { createCodexSessionClient } from "../src/app/lib/codex-session";
import { useCodexSessionStore } from "../src/react-app/domains/session/codex-session-store";
import { ensureCodexTranscriptCached } from "../src/react-app/domains/session/sync/codex-transcript-adapter";
import { transcriptKey } from "../src/react-app/domains/session/sync/session-sync";
import { getReactQueryClient } from "../src/react-app/infra/query-client";

const WORKSPACE = "ws_reseed";
const SESSION = "codex-reseed-1";
const client = createCodexSessionClient({ baseUrl: "http://127.0.0.1:1", token: "token", workspaceId: WORKSPACE });
const originalFetch = globalThis.fetch;

function seedSession(): void {
  useCodexSessionStore.getState().upsertSession({
    id: SESSION, threadId: "reseed-1", title: "Reopened task", workspaceId: WORKSPACE,
    created: "2026-01-01", turnId: null, status: "idle",
  });
}

function seedItems(): void {
  useCodexSessionStore.getState().upsertItem(SESSION, {
    id: "u1", type: "userMessage", turnId: "t1",
    item: { type: "userMessage", id: "u1", content: [{ type: "text", text: "What model are you?" }] },
    text: "", thinking: "", output: "", status: "done",
  });
  useCodexSessionStore.getState().upsertItem(SESSION, {
    id: "a1", type: "agentMessage", turnId: "t1",
    item: { type: "agentMessage", id: "a1", text: "I am Sofia." },
    text: "I am Sofia.", thinking: "", output: "", status: "done",
  });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  getReactQueryClient().clear();
  useCodexSessionStore.getState().clear();
});

// The mount-time restore writes every transcript with setQueryData, so TanStack
// GC collects those entries (no observer) shortly after boot. Reopening the task
// then rendered a blank pane, because codex sessions never query a snapshot.
describe("reopening a task whose cached transcript was collected", () => {
  test("re-seeds the transcript from the store without touching the engine", async () => {
    seedSession();
    seedItems();
    globalThis.fetch = async () => {
      throw new Error("the store already holds this transcript; no read expected");
    };
    await ensureCodexTranscriptCached(client, WORKSPACE, SESSION);
    const cached = getReactQueryClient().getQueryData<UIMessage[]>(transcriptKey(WORKSPACE, SESSION));
    expect(cached?.map((message) => message.role)).toEqual(["user", "assistant"]);
  });

  test("reads the transcript back from the engine when the store is empty", async () => {
    seedSession();
    globalThis.fetch = async () => new Response(
      JSON.stringify({ ok: true, items: [
        { turnId: "t1", item: { type: "userMessage", id: "u1", content: [{ type: "text", text: "hello" }] } },
        { turnId: "t1", item: { type: "agentMessage", id: "a1", text: "hi there" } },
      ] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
    await ensureCodexTranscriptCached(client, WORKSPACE, SESSION);
    expect(getReactQueryClient().getQueryData<UIMessage[]>(transcriptKey(WORKSPACE, SESSION))).toHaveLength(2);
    expect(useCodexSessionStore.getState().sessions[SESSION]?.items).toHaveLength(2);
  });

  test("explains the pane when the transcript cannot be read", async () => {
    seedSession();
    globalThis.fetch = async () => new Response(
      JSON.stringify({ code: "thread_writer_conflict", message: "This task is open elsewhere." }),
      { status: 409, headers: { "content-type": "application/json" } },
    );
    await ensureCodexTranscriptCached(client, WORKSPACE, SESSION);
    expect(useCodexSessionStore.getState().sessions[SESSION]?.warning).toBe("This task is open elsewhere.");
  });

  test("a legacy task's injected context is not rendered as the user's message", async () => {
    seedSession();
    useCodexSessionStore.getState().upsertItem(SESSION, {
      id: "c1", type: "userMessage", turnId: "t1",
      item: { type: "userMessage", id: "c1", content: [{ type: "text", text: [
        "<recommended_plugins>",
        "- Airtable (airtable@openai-curated-remote)",
        "</recommended_plugins>",
        "# AGENTS.md instructions for /Users/mona/Dev/tools/codex/codex-rs",
        "<INSTRUCTIONS>",
        "# Rust/codex-rs",
        "</INSTRUCTIONS>",
        "<environment_context>",
        "  <cwd>/Users/mona/Dev/tools/codex/codex-rs</cwd>",
        "</environment_context>",
      ].join("\n") }] },
      text: "", thinking: "", output: "", status: "done",
    });
    useCodexSessionStore.getState().upsertItem(SESSION, {
      id: "u1", type: "userMessage", turnId: "t1",
      item: { type: "userMessage", id: "u1", content: [{ type: "text", text: "What model are you?" }] },
      text: "", thinking: "", output: "", status: "done",
    });
    await ensureCodexTranscriptCached(client, WORKSPACE, SESSION);
    const cached = getReactQueryClient().getQueryData<UIMessage[]>(transcriptKey(WORKSPACE, SESSION));
    expect(cached).toHaveLength(1);
    const part = cached?.[0]?.parts[0];
    expect(part && "text" in part ? part.text : null).toBe("What model are you?");
  });
});
