import { expect, test } from "bun:test";
import type { CodexEvent } from "./codex-sessions.js";
import { CodexEventLog } from "./codex-event-log.js";

function fakeManager() {
  let listener: (event: CodexEvent) => void = () => {};
  return {
    on: (next: (event: CodexEvent) => void) => { listener = next; return () => {}; },
    emit: (text: string) => listener({ type: "message.delta", sessionId: "s", threadId: "t", text }),
  };
}

test("replays exactly the events after a client's last number", () => {
  const manager = fakeManager();
  const log = new CodexEventLog(manager, 3);
  for (const text of ["a", "b", "c", "d"]) manager.emit(text);
  expect(log.lastSeq).toBe(4);
  expect(log.since(2)?.map((event) => event.seq)).toEqual([3, 4]);
  expect(log.since(4)).toEqual([]);
  // Event 2 fell out of the retained window: the client must resync.
  expect(log.since(0)).toBeNull();
  expect(log.since(5)).toBeNull();
});
