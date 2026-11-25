import type { DynamicToolUIPart, UIMessage } from "ai";
import { expect } from "vitest";
import { test } from "@sofia/testkit";
import { deriveTurnPresentation } from "../../apps/app/src/components/chat/turn-presentation";
import { groupMessages, isMessageGroup } from "../../apps/app/src/components/chat/utils";

function tool(id: string): DynamicToolUIPart {
  return {
    type: "dynamic-tool",
    toolName: "bash",
    toolCallId: id,
    state: "output-available",
    input: { command: `echo ${id}` },
    output: "ok",
  };
}

function assistant(id: string, turnId: string, part: UIMessage["parts"][number]): UIMessage {
  return { id, role: "assistant", metadata: { engine: { turnId } }, parts: [part] };
}

function steer(id: string, turnId: string | undefined, text: string): UIMessage {
  return {
    id,
    role: "user",
    ...(turnId ? { metadata: { engine: { turnId } } } : {}),
    parts: [{ type: "text", text, state: "done" }],
  };
}

test("a steered message stays inside one turn, between the work it interrupted", () => {
  const messages = [
    assistant("work-1", "turn-1", tool("c1")),
    assistant("work-2", "turn-1", tool("c2")),
    steer("steer", "turn-1", "Also check the other file"),
    assistant("work-3", "turn-1", tool("c3")),
    assistant("answer", "turn-1", { type: "text", text: "Done.", state: "done" }),
  ];

  const items = groupMessages(messages, "streaming");
  expect(items).toHaveLength(1);
  const group = items[0];
  if (!isMessageGroup(group)) throw new Error("expected one assistant turn group");
  expect(group.messages.map(entry => entry.message.id)).toEqual(["work-1", "work-2", "work-3", "answer"]);
  expect(group.interjections.map(entry => entry.message.id)).toEqual(["steer"]);

  const presentation = deriveTurnPresentation(group.messages, false, group.interjections);
  expect(presentation.work.map(entry => entry.kind)).toEqual(["milestone", "interjection", "milestone"]);
  expect(presentation.answerItems.map(entry => entry.message.id)).toEqual(["answer"]);
  const interjection = presentation.work[1];
  expect(interjection?.kind === "interjection" && interjection.item.message.id).toBe("steer");
});

test("the optimistic steer bubble without turn metadata is grouped the same way", () => {
  const messages = [
    assistant("work-1", "turn-1", tool("c1")),
    steer("codex-user-pending-0", undefined, "Use the other file"),
    assistant("work-2", "turn-1", tool("c2")),
  ];

  const items = groupMessages(messages, "streaming");
  expect(items).toHaveLength(1);
  const group = items[0];
  if (!isMessageGroup(group)) throw new Error("expected one assistant turn group");
  expect(group.messages.map(entry => entry.message.id)).toEqual(["work-1", "work-2"]);
  expect(group.interjections.map(entry => entry.message.id)).toEqual(["codex-user-pending-0"]);
});

test("a real following user turn still starts its own group", () => {
  const messages = [
    assistant("work-1", "turn-1", tool("c1")),
    steer("next-prompt", "turn-2", "Now do something else"),
    assistant("work-2", "turn-2", tool("c2")),
  ];

  const items = groupMessages(messages, "idle");
  expect(items).toHaveLength(3);
  expect(items[0] && isMessageGroup(items[0]) && items[0].messages.map(entry => entry.message.id)).toEqual(["work-1"]);
  expect(items[1] && !isMessageGroup(items[1]) && items[1].message.id).toBe("next-prompt");
  expect(items[2] && isMessageGroup(items[2]) && items[2].messages.map(entry => entry.message.id)).toEqual(["work-2"]);
});
