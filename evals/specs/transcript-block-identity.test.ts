import type { UIMessage } from "ai";
import { expect } from "vitest";
import { test } from "@sofia/testkit";
import { mergeSnapshotIntoCachedMessages } from "../../apps/app/src/react-app/domains/session/sync/message-merge";

function text(id: string, value: string): UIMessage["parts"][number] {
  return { type: "text", text: value, providerMetadata: { engine: { partId: id } } };
}
function message(parts: UIMessage["parts"]): UIMessage {
  return { id: "assistant-turn", role: "assistant", parts };
}

test("snapshot reconciliation preserves block identities and intervening live blocks", () => {
  const cached = message([text("commentary", "Checking the page"), text("progress", "Read completed"), text("answer", "The final answer")]);
  const snapshot = message([text("commentary", "Checking"), text("answer", "The final answer")]);
  const merged = mergeSnapshotIntoCachedMessages([snapshot], [cached]);
  expect(merged[0].parts).toEqual(cached.parts);
  expect(mergeSnapshotIntoCachedMessages([snapshot], merged)[0].parts).toEqual(cached.parts);
});

test("out-of-order tool blocks retain their own results and cannot restart after completion", () => {
  const complete: UIMessage["parts"][number] = { type: "dynamic-tool", toolName: "read", toolCallId: "read-one", state: "output-available", input: { path: "one" }, output: "one result" };
  const other: UIMessage["parts"][number] = { type: "dynamic-tool", toolName: "read", toolCallId: "read-two", state: "output-available", input: { path: "two" }, output: "two result" };
  const pending: UIMessage["parts"][number] = { type: "dynamic-tool", toolName: "read", toolCallId: "read-one", state: "input-available", input: { path: "one" } };
  const merged = mergeSnapshotIntoCachedMessages([message([other, pending])], [message([complete, other])]);
  expect(merged[0].parts).toEqual([other, complete]);
});

test("legacy unkeyed streamed text still retains its longer content", () => {
  const merged = mergeSnapshotIntoCachedMessages([message([{type:"text",text:"Hello"}])], [message([{type:"text",text:"Hello world"}])]);
  expect(merged[0].parts).toEqual([{type:"text",text:"Hello world"}]);
});
