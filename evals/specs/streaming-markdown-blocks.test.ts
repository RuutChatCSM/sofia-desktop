import { expect } from "vitest";
import { test } from "@sofia/testkit";
import { splitMarkdownBlocks } from "../../apps/app/src/components/markdown/stream-blocks";
import { shareMessageIdentity } from "../../apps/app/src/react-app/domains/session/sync/message-identity";
import type { UIMessage } from "ai";

test("streaming markdown splits at blank lines without cutting fences or list continuations", () => {
  expect(splitMarkdownBlocks("a\nb\n\nc")).toEqual(["a\nb\n", "c"]);
  expect(splitMarkdownBlocks("```\nx\n\ny\n```\n\nz")).toEqual(["```\nx\n\ny\n```\n", "z"]);
  expect(splitMarkdownBlocks("- a\n\n  more\n\n- b")).toEqual(["- a\n\n  more\n", "- b"]);
  const text = "# T\n\npara one\n\n```ts\nconst a = 1\n\nconst b\n```\n\n- x\n- y\n\nend";
  expect(splitMarkdownBlocks(text).join("\n")).toBe(text);
});

test("finished blocks keep identical text while the last block streams", () => {
  const before = splitMarkdownBlocks("intro\n\nsecond para");
  const after = splitMarkdownBlocks("intro\n\nsecond paragraph grows");
  expect(after[0]).toBe(before[0]);
  expect(after[1]).not.toBe(before[1]);
});

test("rebuilt transcripts keep the identity of unchanged messages", () => {
  const user = (text: string): UIMessage => ({ id: "u1", role: "user", metadata: { engine: { turnId: "t" } }, parts: [{ type: "text", text, state: "done" }] });
  const answer: UIMessage = { id: "a1", role: "assistant", parts: [{ type: "text", text: "hi" }] };
  const previous = [user("hello"), answer];
  const same = shareMessageIdentity(previous, [user("hello"), answer]);
  expect(same).toBe(previous);
  const edited = shareMessageIdentity(previous, [user("hello!"), answer]);
  expect(edited).not.toBe(previous);
  expect(edited[1]).toBe(answer);
  expect(edited[0]).not.toBe(previous[0]);
});
