import { createServer, type ServerResponse } from "node:http";
import { expect, onTestFinished } from "vitest";
import { evalIn } from "@sofia/behaviors";
import { desktop } from "@sofia/hosts";
import { eventually, needs, test } from "@sofia/testkit";

test("Electron restores missed durable messages and interruption after an actual SSE socket drop", { timeout: 180_000 }, async ({ evidence }) => {
  needs({ optIn: ["SOFIA_EVAL_E2E_TESTS"], placement: "local" });
  let connection: ServerResponse | undefined;
  let connections = 0;
  let itemReads = 0;
  let disconnected = false;
  const session = { id: "codex-network-fixture", threadId: "network-fixture", title: "Network recovery", workspaceId: "network-fixture", created: "2026-10-11", turnId: "turn-1", status: "running" };
  const base = { sessionId: session.id, threadId: session.threadId, turnId: "turn-1" };
  const send = (event: unknown) => connection?.write(`data: ${JSON.stringify(event)}\n\n`);
  const server = createServer((request, response) => {
    response.setHeader("access-control-allow-origin", "*");
    response.setHeader("access-control-allow-headers", "authorization,content-type,x-sofia-host-token");
    if (request.method === "OPTIONS") { response.end(); return; }
    if (request.url?.endsWith("/stream")) {
      connections += 1; connection = response;
      response.writeHead(200, { "content-type": "text/event-stream" });
      send({ type: "stream.ready", streamId: `stream-${connections}` });
      if (!disconnected) {
        send({ type: "session.created", session });
        send({ type: "item.started", ...base, itemType: "agentMessage", item: { id: "answer", type: "agentMessage" } });
        send({ type: "message.delta", ...base, itemId: "answer", text: "Visible partial" });
        send({ type: "item.started", ...base, itemType: "commandExecution", item: { id: "tool", type: "commandExecution", command: "sleep 10", status: "inProgress" } });
      }
      return;
    }
    response.setHeader("content-type", "application/json");
    if (request.url?.endsWith("/engine")) {
      response.end(JSON.stringify({ ok: true, sessions: [{ ...session, status: disconnected ? "idle" : "running" }] })); return;
    }
    if (request.url?.endsWith("/items")) {
      itemReads += 1;
      response.end(JSON.stringify({ ok: true, outcomes: disconnected ? [{ turnId: "turn-1", outcome: "cancelled" }] : [], items: [
        { turnId: "turn-1", item: { id: "answer", type: "agentMessage", text: disconnected ? "Visible partial recovered completion" : "Visible partial" } },
        { turnId: "turn-1", item: { id: "tool", type: "commandExecution", command: "sleep 10", status: "inProgress" } },
        ...(disconnected ? [{ turnId: "turn-1", item: { id: "missed", type: "agentMessage", text: "Missed while offline" } }] : []),
      ] })); return;
    }
    response.end(JSON.stringify({ ok: true, processes: [] }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture did not bind");
  await using app = await desktop({ name: "session-reconnect" });
  await evalIn(app, `(async()=>{
    const {createCodexSessionClient}=await import('/src/app/lib/codex-session.ts');
    const {runCodexStream,useCodexSessionStore}=await import('/src/react-app/domains/session/codex-session-store.ts');
    const {recoverCodexSessions}=await import('/src/react-app/domains/session/sync/codex-transcript-adapter.ts');
    const {createReconnectRecovery}=await import('/src/react-app/domains/session/sync/reconnect-recovery.ts');
    const client=createCodexSessionClient({baseUrl:'http://127.0.0.1:${address.port}',workspaceId:'network-fixture',token:'fixture'});
    const controller=new AbortController();window.__networkRecovery={controller,store:useCodexSessionStore,ready:0};
    const recover=createReconnectRecovery(()=>recoverCodexSessions(client,controller.signal),controller.signal,error=>useCodexSessionStore.getState().setError(String(error)));
    window.__networkRecovery.task=runCodexStream(client,controller.signal,event=>{if(event.type==='stream.ready'){window.__networkRecovery.ready++;recover();}});
  })()`, { awaitPromise: true });
  type Snapshot = { streaming: boolean; error: string | null; ready: number; entry?: { session: { status: string }; items: { id: string; text: string; status: string; turnOutcome?: string }[] } };
  const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
  const validSnapshot = (value: unknown): value is Snapshot => record(value) && typeof value.streaming === "boolean" && (value.error === null || typeof value.error === "string") && typeof value.ready === "number" && (value.entry === undefined || (record(value.entry) && record(value.entry.session) && typeof value.entry.session.status === "string" && Array.isArray(value.entry.items) && value.entry.items.every(item => record(item) && typeof item.id === "string" && typeof item.text === "string" && typeof item.status === "string" && (item.turnOutcome === undefined || typeof item.turnOutcome === "string"))));
  const snapshot = async () => {
    const value = await evalIn(app, `(()=>{const state=window.__networkRecovery.store.getState();return {streaming:state.streaming,error:state.error,ready:window.__networkRecovery.ready,entry:state.sessions['codex-network-fixture']}})()`);
    if (!validSnapshot(value)) throw new Error("Invalid recovery snapshot");
    return value;
  };
  await eventually(async () => { expect((await snapshot()).entry?.items.find(item => item.id === "answer")?.text).toBe("Visible partial"); expect(itemReads).toBeGreaterThan(0); return true; }, { within: 10_000 });
  disconnected = true;
  if (!connection) throw new Error("No live SSE response");
  connection.destroy();
  await eventually(async () => { const state = await snapshot(); expect(state.streaming).toBe(false); expect(state.error).toBeTruthy(); expect(state.entry?.items.find(item => item.id === "answer")?.text).toBe("Visible partial"); return true; }, { within: 3_000 });
  await eventually(async () => {
    const state = await snapshot(); expect(connections).toBeGreaterThanOrEqual(2); expect(state.ready).toBeGreaterThanOrEqual(2); expect(state.streaming).toBe(true); expect(state.error).toBeNull();
    expect(state.entry?.session.status).toBe("idle"); expect(state.entry?.items.map(item => item.id)).toEqual(["answer", "tool", "missed"]);
    expect(state.entry?.items[0]).toMatchObject({ text: "Visible partial recovered completion", status: "done", turnOutcome: "cancelled" });
    expect(state.entry?.items[1]).toMatchObject({ status: "error", turnOutcome: "cancelled" });
    expect(state.entry?.items[2]?.text).toBe("Missed while offline"); return true;
  }, { within: 10_000 });
  // A second real drop must merge identical durable items rather than duplicate them.
  connection.destroy();
  await eventually(async () => { expect(connections).toBeGreaterThanOrEqual(3); expect(itemReads).toBeGreaterThanOrEqual(3); expect((await snapshot()).entry?.items.map(item => item.id)).toEqual(["answer", "tool", "missed"]); return true; }, { within: 10_000 });
  await evalIn(app, `window.__networkRecovery.controller.abort();window.__networkRecovery.task`, { awaitPromise: true });
  evidence.recordAssertionEvidence("Real SSE reconnect", "Local Electron production HTTP/SSE client and retry loop survive two destroyed sockets, retain partial content while offline, recover missed durable text once, clear disconnect errors and restore cancelled tool state.", true);
});
