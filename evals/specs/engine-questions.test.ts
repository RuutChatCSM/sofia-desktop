import { EventEmitter } from "node:events";
import { expect } from "vitest";
import { test } from "@sofia/testkit";
import { CodexSessionManager } from "../../apps/server/src/codex-sessions";

test("engine questions route to their thread and replies retain numeric request IDs and question IDs", () => {
  const manager = new CodexSessionManager({ bin: "/unused", cwd: "/tmp" });
  const engine = new EventEmitter();
  const replies: unknown[] = [];
  Reflect.set(engine, "respond", (id: unknown, result: unknown) => replies.push({ id, result }));
  Reflect.set(manager, "engine", engine);
  Reflect.set(manager, "sessions", new Map([
    ["codex-one", { id: "codex-one", threadId: "one", status: "running" }],
    ["codex-two", { id: "codex-two", threadId: "two", status: "running" }],
  ]));
  const setup = Reflect.get(manager, "setupEngineListeners");
  if (typeof setup !== "function") throw new Error("missing listeners");
  setup.call(manager, engine);
  const events: unknown[] = [];
  manager.on(event => events.push(event));
  engine.emit("request", { id: 42, method: "item/tool/requestUserInput", params: {
    threadId: "two", turnId: "turn", itemId: "item", isBlocking: false,
    questions: [{ id: "choice", header: "Pick", question: "Which?", options: [{ label: "A", description: "First" }] },
      { id: "credential", header: "Key", question: "Key?", isSecret: true, options: null }],
  } });
  const pending = manager.listQuestions();
  expect(pending).toHaveLength(1);
  expect(pending[0].sessionID).toBe("codex-two");
  expect(pending[0].isBlocking).toBe(false);
  expect(pending[0].questions[1].secret).toBe(true);
  expect(() => manager.respondQuestion("42", [["A"]])).toThrow("Answer every question");
  expect(manager.listQuestions()).toHaveLength(1);
  manager.respondQuestion("42", [["A"], ["test-secret"]]);
  expect(replies).toEqual([{ id: 42, result: { answers: { choice: { answers: ["A"] }, credential: { answers: ["test-secret"] } } } }]);
  expect(manager.listQuestions()).toEqual([]);
  expect(events).toContainEqual({ type: "question.replied", sessionId: "codex-two", properties: { sessionID: "codex-two", requestID: "42" } });
  expect(() => manager.respondQuestion("42", [["A"], ["test-secret"]])).toThrow("no longer pending");
  engine.emit("request", { id: "next", method: "item/tool/requestUserInput", params: {
    threadId: "two", questions: [{ id: "followup", question: "Continue?", header: "Next", options: [] }],
  } });
  engine.emit("serverRequest/resolved", { threadId: "one", requestId: "next" });
  expect(manager.listQuestions()).toHaveLength(1);
  engine.emit("serverRequest/resolved", { threadId: "two", requestId: "next" });
  expect(manager.listQuestions()).toEqual([]);
});
