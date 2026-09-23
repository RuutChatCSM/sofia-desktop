import { createServer } from "node:http";
import { mkdir, mkdtemp, realpath, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { needs, test } from "@sofia/testkit";
import { CodexSessionManager } from "../../apps/server/src/codex-sessions.ts";

test("Released Sofia creates chats, reloads providers and continues persisted chats in the pinned home", async () => {
  needs({ env: ["SOFIA_TEST_BIN"] });
  const bin = process.env.SOFIA_TEST_BIN;
  if (!bin) throw new Error("SOFIA_TEST_BIN is required");
  const root = await realpath(await mkdtemp(join(tmpdir(), "sofia-native-chat-")));
  const home = join(root, "engine"), userHome = join(root, "user");
  await mkdir(home); await mkdir(userHome);
  const bodies: string[] = [];
  let rejectedRequests = 0;
  const api = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    if (request.method === "GET") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "sofia-test-model", object: "model" }] }));
      return;
    }
    bodies.push(body);
    const payload: { messages: Array<{ role: string; content?: string; reasoning_content?: string }> } = JSON.parse(body);
    if (payload.messages.some((message) => message.role === "assistant" && typeof message.reasoning_content !== "string")) {
      rejectedRequests++;
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "The `reasoning_content` in the thinking mode must be passed back to the API." } }));
      return;
    }
    if (payload.messages.at(-1)?.content === "First unique message") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`data: ${JSON.stringify({ id: "tool-test", choices: [{ index: 0, delta: {
        content: "I will inspect the project.", reasoning_content: "",
        tool_calls: [{ index: 0, id: "sofia-tool", type: "function", function: { name: "exec_command", arguments: JSON.stringify({ cmd: "pwd", login: false }) } }],
      }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end([
      { id: "test", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "Sofia test reply." }, finish_reason: null }] },
      { id: "test", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ].map((value) => `data: ${JSON.stringify(value)}\n\n`).join("") + "data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  const address = api.address();
  if (!address || typeof address === "string") throw new Error("API failed to bind");
  const config = (provider: string) => `model_provider = "${provider}"\nmodel = "sofia-test-model"\nmodel_context_window = 32768\napproval_policy = "never"\nsandbox_mode = "danger-full-access"\n[model_providers.${provider}]\nname = "Sofia test"\nbase_url = "http://127.0.0.1:${address.port}/v1"\nwire_api = "chatcompletions"\n`;
  const manager = new CodexSessionManager({ bin, cwd: root, codexHome: home, env: { HOME: userHome } }, "ws");
  async function promptAndWait(id: string, text: string) {
    let finish: () => void = () => {};
    let fail: (error: Error) => void = () => {};
    const completion = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
    const off = manager.on((event) => {
      if (!("sessionId" in event) || event.sessionId !== id) return;
      if (event.type === "error") fail(new Error(event.message));
      if (event.type === "turn.completed") finish();
    });
    const timeout = setTimeout(() => fail(new Error("Sofia turn timed out")), 30000);
    try { await Promise.all([manager.prompt(id, text), completion]); }
    finally { clearTimeout(timeout); off(); }
  }
  try {
    await writeFile(join(home, "config.toml"), config("sofia-first"));
    const session = await manager.createSession({ title: "Native chat", workspaceId: "ws", providerId: "sofia-first", model: "sofia-test-model" });
    expect(manager.engineInfo.codexHome).toBe(home);
    expect(manager.engineInfo.userAgent).toMatch(/^sofia\//);
    await promptAndWait(session.id, "First unique message");
    const firstPid = manager.engineInfo.pid;
    // Native thread/start reloads config: changing providers must not kill turns or streams.
    await writeFile(join(home, "config.toml"), config("sofia-second") + '[model_providers.sofia-first]\nname = "First"\nbase_url = "http://127.0.0.1:' + address.port + '/v1"\nwire_api = "chatcompletions"\n');
    const second = await manager.createSession({ title: "Updated provider", workspaceId: "ws", providerId: "sofia-second", model: "sofia-test-model" });
    expect(manager.engineInfo.pid).toBe(firstPid);
    await promptAndWait(second.id, "Second provider message");
    await manager.close();
    await promptAndWait(session.id, "Continue unique message");
    // The native engine also makes goal-verification calls. Identify the three
    // conversation requests by their actual user input, excluding that traffic.
    const chatBodies = bodies.filter((body) => {
      const request: { messages?: Array<{ role: string; content: string }> } = JSON.parse(body);
      return ["First unique message", "Second provider message", "Continue unique message"].includes(request.messages?.at(-1)?.content ?? "");
    });
    expect(chatBodies).toHaveLength(3);
    expect(rejectedRequests).toBe(0);
    expect(bodies.some((body) => body.includes('"tool_call_id":"sofia-tool"'))).toBe(true);
    expect(chatBodies[2]).toContain("First unique message");
    expect(chatBodies[2]).toContain("Continue unique message");
    expect(chatBodies[2]).not.toContain("Second provider message");
    expect(await readFile(join(home, "config.toml"), "utf8")).toContain("sofia-second");
    expect(manager.getSession(session.id)?.threadId).toBe(session.threadId);
  } finally {
    await manager.close();
    api.closeAllConnections();
    await new Promise<void>((resolve) => api.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
