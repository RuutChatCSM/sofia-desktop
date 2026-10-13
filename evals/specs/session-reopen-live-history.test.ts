import { expect } from "vitest";
import { test } from "@sofia/testkit";
import { createCodexSessionClient } from "../../apps/app/src/app/lib/codex-session";
import { useCodexSessionStore } from "../../apps/app/src/react-app/domains/session/codex-session-store";
import { ensureCodexTranscriptCached } from "../../apps/app/src/react-app/domains/session/sync/codex-transcript-adapter";
import { getReactQueryClient } from "../../apps/app/src/react-app/infra/query-client";
import { transcriptKey } from "../../apps/app/src/react-app/domains/session/sync/session-sync";

test("switching back renders known live narrative before a delayed durable read", async () => {
  const store = useCodexSessionStore.getState();
  store.clear();
  const sessionId = "codex-live-reopen";
  const workspaceId = "reopen-workspace";
  store.upsertSession({ id: sessionId, threadId: "live", title: "Live", workspaceId, created: "2026-10-12", turnId: "turn", status: "running" });
  store.upsertItem(sessionId, { id: "commentary", type: "agentMessage", turnId: "turn", item: { type: "agentMessage", text: "Waiting for detailed findings", phase: "commentary" }, text: "Waiting for detailed findings", thinking: "", output: "", status: "done" });
  const query = getReactQueryClient();
  query.removeQueries({ queryKey: transcriptKey(workspaceId, sessionId), exact: true });
  let release = () => {};
  const pending = new Promise<void>(resolve => { release = resolve; });
  const client = createCodexSessionClient({ baseUrl: "http://unused.invalid", token: "test", workspaceId });
  client.items = async () => { await pending; return { ok: true, items: [] }; };
  const recovery = ensureCodexTranscriptCached(client, workspaceId, sessionId);
  expect(JSON.stringify(query.getQueryData(transcriptKey(workspaceId, sessionId)))).toContain("Waiting for detailed findings");
  expect(useCodexSessionStore.getState().sessions[sessionId].session.status).toBe("running");
  release();
  await recovery;
});
