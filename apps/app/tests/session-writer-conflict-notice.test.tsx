import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { createCodexSessionClient, isThreadWriterConflictError } from "../src/app/lib/codex-session";
import { SofiaServerError } from "../src/app/lib/sofia-server";
import { SessionNotice } from "../src/react-app/domains/session/chat/session-notice";
import { useCodexSessionStore } from "../src/react-app/domains/session/codex-session-store";
import { restoreCodexSessionItems } from "../src/react-app/domains/session/sync/codex-transcript-adapter";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  useCodexSessionStore.getState().clear();
});

describe("task held by another Sofia process", () => {
  test("the client recognises the server's conflict code", () => {
    expect(isThreadWriterConflictError(new SofiaServerError(409, "thread_writer_conflict", "held elsewhere"))).toBe(true);
    expect(isThreadWriterConflictError(new SofiaServerError(502, "sofia_request_failed", "boom"))).toBe(false);
    expect(isThreadWriterConflictError(new Error("thread one already has an active writer"))).toBe(false);
  });

  test("a transcript that cannot be read is explained instead of leaving an empty pane", async () => {
    useCodexSessionStore.getState().upsertSession({
      id: "codex-held", threadId: "held", title: "Held task", workspaceId: "ws", created: "2026-01-01", turnId: null, status: "idle",
    });
    const message = "This task is open elsewhere. Close it there and retry before continuing here.";
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ code: "thread_writer_conflict", message }), { status: 409, headers: { "content-type": "application/json" } });
    const client = createCodexSessionClient({ baseUrl: "http://127.0.0.1:1", token: "token", workspaceId: "ws" });
    await restoreCodexSessionItems(client, "ws", "codex-held");
    expect(useCodexSessionStore.getState().sessions["codex-held"]?.warning).toBe(message);
  });

  test("the notice renders the explanation above the transcript", () => {
    const markup = renderToStaticMarkup(<SessionNotice message="This task is open elsewhere. Close it there and retry before continuing here." />);
    expect(markup).toContain("data-session-notice");
    expect(markup).toContain("open elsewhere");
  });
});
