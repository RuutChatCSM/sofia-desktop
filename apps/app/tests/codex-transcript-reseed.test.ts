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

// The engine echoes a user turn as text only, so an attachment the user sent
// used to be visible in the composer and then nowhere: the transcript dropped
// it. The parts captured at send time are merged back onto the echoed message.
describe("a sent attachment survives the engine's text-only echo", () => {
  test("the image part rides on the echoed user message", async () => {
    seedSession();
    seedItems();
    globalThis.fetch = async () => {
      throw new Error("the store already holds this transcript; no read expected");
    };
    useCodexSessionStore.getState().addPendingUserMessage(SESSION, "What model are you?", [
      { type: "file", mediaType: "image/png", filename: "shot.png", url: "blob:http://localhost/shot.png" },
    ]);
    // The echo arrives as plain text; the optimistic copy is dropped with it.
    useCodexSessionStore.getState().confirmPendingUserMessage(SESSION, "What model are you?");
    expect(useCodexSessionStore.getState().sessions[SESSION]?.pendingUserMessages).toEqual([]);

    await ensureCodexTranscriptCached(client, WORKSPACE, SESSION);
    const cached = getReactQueryClient().getQueryData<UIMessage[]>(transcriptKey(WORKSPACE, SESSION));
    const user = cached?.find((message) => message.role === "user");
    const files = (user?.parts ?? []).filter((part) => part.type === "file");
    expect(files.map((part) => part.url)).toEqual(["blob:http://localhost/shot.png"]);
  });

});

// Rebuilding every message object on every frame is what made a long session
// stop responding while an answer streamed: fresh objects defeat React.memo, so
// every row re-rendered ~60x/second. Unchanged items now keep their message.
describe("transcript rebuild keeps unchanged messages by identity", () => {
  test("only the item that changed gets a new message object", async () => {
    seedSession();
    seedItems();
    const { syncCodexTranscriptToCache } = await import("../src/react-app/domains/session/sync/codex-transcript-adapter");
    globalThis.fetch = async () => {
      throw new Error("the store already holds this transcript; no read expected");
    };
    syncCodexTranscriptToCache(WORKSPACE, SESSION);
    const first = getReactQueryClient().getQueryData<UIMessage[]>(transcriptKey(WORKSPACE, SESSION));
    expect(first).toHaveLength(2);

    // A streamed delta touches only the assistant item.
    useCodexSessionStore.getState().appendItemText(SESSION, "a1", " more");
    syncCodexTranscriptToCache(WORKSPACE, SESSION);
    const second = getReactQueryClient().getQueryData<UIMessage[]>(transcriptKey(WORKSPACE, SESSION));

    expect(second?.[0]).toBe(first?.[0]);
    expect(second?.[1]).not.toBe(first?.[1]);
  });
});

// Attachments only exist in the transcript because we keep them: the engine
// echoes a user turn as text. After a reload the in-memory copy is gone, so the
// durable store has to put the image back.
describe("a sent image survives a reload of the session", () => {
  test("the transcript renders it from the durable record", async () => {
    const { recordSentAttachments } = await import("../src/react-app/domains/session/sync/sent-attachment-store");
    seedSession();
    seedItems();
    const url = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
    recordSentAttachments(SESSION, "What model are you?", [
      { type: "file", mediaType: "image/png", filename: "shot.png", url },
    ]);
    // No in-memory sentUserMessages: this is the post-reload state.
    expect(useCodexSessionStore.getState().sessions[SESSION]?.sentUserMessages).toEqual([]);
    globalThis.fetch = async () => {
      throw new Error("the store already holds this transcript; no read expected");
    };

    await ensureCodexTranscriptCached(client, WORKSPACE, SESSION);
    const cached = getReactQueryClient().getQueryData<UIMessage[]>(transcriptKey(WORKSPACE, SESSION));
    const user = cached?.find((message) => message.role === "user");
    const files = (user?.parts ?? []).filter((part) => part.type === "file");
    expect(files.map((part) => part.url)).toEqual([url]);
  });
});

// The composer's `[attachment …]` placeholder is stripped before the turn is
// sent, so the visible text and the echoed text differ. Matching attachments on
// the visible text made a just-sent image vanish the instant the echo landed.
describe("attachments survive the display/prompt text difference", () => {
  test("a later repeated prompt does not attach its file to an older message", async () => {
    const { recordSentAttachments } = await import("../src/react-app/domains/session/sync/sent-attachment-store");
    const sessionId = "codex-repeated-prompt-unique";
    useCodexSessionStore.getState().upsertSession({
      id: sessionId, threadId: "repeated-prompt-unique", title: "Repeated prompt", workspaceId: WORKSPACE,
      created: "2026-01-01", turnId: null, status: "idle",
    });
    for (const id of ["repeat-old", "repeat-new"]) {
      useCodexSessionStore.getState().upsertItem(sessionId, {
        id, type: "userMessage", turnId: id,
        item: { type: "userMessage", id, content: [{ type: "text", text: "same prompt" }] },
        text: "", thinking: "", output: "", status: "done",
      });
    }
    const file = { type: "file" as const, mediaType: "image/png", filename: "new.png", url: "data:image/png;base64,new" };
    recordSentAttachments(sessionId, "same prompt", [{ type: "text", text: "same prompt", state: "done" }, file], undefined, true, 1);
    await ensureCodexTranscriptCached(client, WORKSPACE, sessionId);
    const users = getReactQueryClient().getQueryData<UIMessage[]>(transcriptKey(WORKSPACE, sessionId))?.filter((message) => message.role === "user");
    expect(users?.[0]?.parts.some((part) => part.type === "file")).toBe(false);
    expect(users?.[1]?.parts.some((part) => part.type === "file")).toBe(true);
  });

  test("ordered text and files survive the text-only echo", async () => {
    const { recordSentAttachments } = await import("../src/react-app/domains/session/sync/sent-attachment-store");
    seedSession();
    useCodexSessionStore.getState().upsertItem(SESSION, {
      id: "ordered-u1", type: "userMessage", turnId: "ordered-t1",
      item: { type: "userMessage", id: "ordered-u1", content: [{ type: "text", text: "before after" }] },
      text: "", thinking: "", output: "", status: "done",
    });
    const parts: UIMessage["parts"] = [
      { type: "text", text: "before ", state: "done" },
      { type: "file", mediaType: "text/plain", filename: "note.txt", url: "file:///workspace/note.txt" },
      { type: "text", text: " after", state: "done" },
    ];
    recordSentAttachments(SESSION, "before after", parts, undefined, true);
    await ensureCodexTranscriptCached(client, WORKSPACE, SESSION);
    const user = getReactQueryClient().getQueryData<UIMessage[]>(transcriptKey(WORKSPACE, SESSION))?.find((message) => message.role === "user");
    expect(user?.parts).toEqual(parts);
  });

  test("an annotation remains a chip after the engine echoes its context", async () => {
    const { recordSentAttachments } = await import("../src/react-app/domains/session/sync/sent-attachment-store");
    seedSession();
    const context = "On https://example.com/, look at region at 10, 20 (30 × 40). Fix this.";
    useCodexSessionStore.getState().upsertItem(SESSION, {
      id: "annotation-u1", type: "userMessage", turnId: "annotation-t1",
      item: { type: "userMessage", id: "annotation-u1", content: [{ type: "text", text: context }] },
      text: "", thinking: "", output: "", status: "done",
    });
    const annotation = { type: "file" as const, mediaType: "application/x-sofia-annotation", filename: "Annotation", url: `data:application/x-sofia-annotation,${encodeURIComponent(context)}` };
    recordSentAttachments(SESSION, context, [annotation], "");
    await ensureCodexTranscriptCached(client, WORKSPACE, SESSION);
    const user = getReactQueryClient().getQueryData<UIMessage[]>(transcriptKey(WORKSPACE, SESSION))?.find((message) => message.role === "user");
    expect(user?.parts).toEqual([annotation]);
  });

  test("matches the echo even though the visible text had a placeholder", async () => {
    seedSession();
    useCodexSessionStore.getState().upsertItem(SESSION, {
      id: "u1", type: "userMessage", turnId: "t1",
      item: { type: "userMessage", id: "u1", content: [{ type: "text", text: "look at this" }] },
      text: "", thinking: "", output: "", status: "done",
    });
    const url = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
    useCodexSessionStore.getState().addPendingUserMessage(
      SESSION,
      "[attachment att-1] look at this",
      [{ type: "file", mediaType: "image/png", filename: "shot.png", url }],
      "look at this",
    );
    globalThis.fetch = async () => {
      throw new Error("the store already holds this transcript; no read expected");
    };

    await ensureCodexTranscriptCached(client, WORKSPACE, SESSION);
    const cached = getReactQueryClient().getQueryData<UIMessage[]>(transcriptKey(WORKSPACE, SESSION));
    const user = cached?.find((message) => message.role === "user");
    expect((user?.parts ?? []).filter((part) => part.type === "file").map((part) => part.url)).toEqual([url]);
  });

  test("an image-only turn renders with no text at all", async () => {
    const { recordSentAttachments } = await import("../src/react-app/domains/session/sync/sent-attachment-store");
    seedSession();
    useCodexSessionStore.getState().upsertItem(SESSION, {
      id: "u1", type: "userMessage", turnId: "t1",
      item: { type: "userMessage", id: "u1", content: [] },
      text: "", thinking: "", output: "", status: "done",
    });
    const url = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
    recordSentAttachments(SESSION, "", [{ type: "file", mediaType: "image/png", filename: "shot.png", url }]);
    globalThis.fetch = async () => {
      throw new Error("the store already holds this transcript; no read expected");
    };

    await ensureCodexTranscriptCached(client, WORKSPACE, SESSION);
    const cached = getReactQueryClient().getQueryData<UIMessage[]>(transcriptKey(WORKSPACE, SESSION));
    const user = cached?.find((message) => message.role === "user");
    expect(user).toBeDefined();
    expect((user?.parts ?? []).filter((part) => part.type === "file").map((part) => part.url)).toEqual([url]);
  });
});

// Whatever the record is keyed on, the attachment belongs to the next unconsumed
// user turn in submission order. This is the state the live app was in when the
// image vanished: records keyed on the visible text, echo carrying the prompt
// text (placeholder stripped).
describe("attachment merge tolerates a drifted key", () => {
  test("a record keyed on the visible text still attaches to its echo", async () => {
    const { recordSentAttachments } = await import("../src/react-app/domains/session/sync/sent-attachment-store");
    seedSession();
    useCodexSessionStore.getState().upsertItem(SESSION, {
      id: "u1", type: "userMessage", turnId: "t1",
      item: { type: "userMessage", id: "u1", content: [{ type: "text", text: "the font colours should be fainter" }] },
      text: "", thinking: "", output: "", status: "done",
    });
    const url = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
    recordSentAttachments(SESSION, "[attachment att-1] the font colours should be fainter", [
      { type: "file", mediaType: "image/png", filename: "shot.png", url },
    ]);
    globalThis.fetch = async () => {
      throw new Error("the store already holds this transcript; no read expected");
    };

    await ensureCodexTranscriptCached(client, WORKSPACE, SESSION);
    const cached = getReactQueryClient().getQueryData<UIMessage[]>(transcriptKey(WORKSPACE, SESSION));
    const user = cached?.find((message) => message.role === "user");
    expect((user?.parts ?? []).filter((part) => part.type === "file").map((part) => part.url)).toEqual([url]);
  });
});
