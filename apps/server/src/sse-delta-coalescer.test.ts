import { expect, test } from "bun:test";
import type { CodexEvent } from "./codex-sessions.js";
import { createDeltaCoalescer } from "./sse-delta-coalescer.js";

const delta = (text: string, itemId = "a"): CodexEvent => ({ type: "message.delta", sessionId: "s", threadId: "t", text, itemId });

test("merges same-item deltas and flushes before other events in order", () => {
  const sent: CodexEvent[] = [];
  const coalescer = createDeltaCoalescer((event) => sent.push(event), 1_000);
  coalescer.push(delta("he"));
  coalescer.push(delta("llo"));
  coalescer.push(delta("x", "b"));
  coalescer.push({ type: "item.completed", sessionId: "s", threadId: "t", itemType: "agentMessage", item: {}, turnId: "turn" });
  expect(sent.map((event) => event.type === "message.delta" ? `${event.itemId}:${event.text}` : event.type)).toEqual(["a:hello", "b:x", "item.completed"]);
});

test("flushes pending text after the window", async () => {
  const sent: CodexEvent[] = [];
  const coalescer = createDeltaCoalescer((event) => sent.push(event), 10);
  coalescer.push(delta("a"));
  coalescer.push(delta("b"));
  expect(sent).toHaveLength(0);
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(sent).toEqual([delta("ab")]);
});
