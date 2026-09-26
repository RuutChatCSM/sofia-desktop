import { describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";

import { getAggregateOnlyParts, getAssistantRenderGroups } from "../src/components/chat/utils";
import { mergeSnapshotIntoCachedMessages } from "../src/react-app/domains/session/sync/message-merge";

/**
 * Engine output for an interrupted turn can violate the `ai` part types: a
 * reasoning or text part arrives with no text at all. The cast is the point of
 * the test — it is the shape that used to blank the app when Stop was pressed.
 */
function partWithMissingText(type: "reasoning" | "text"): UIMessage["parts"][number] {
  return { type, state: "done" } as UIMessage["parts"][number];
}

function assistantMessage(id: string, parts: UIMessage["parts"]): UIMessage {
  return { id, role: "assistant", parts };
}

describe("an interrupted turn", () => {
  test("renders even when a reasoning part has no text", () => {
    const parts: UIMessage["parts"] = [
      partWithMissingText("reasoning"),
      { type: "text", text: "the partial answer", state: "done" },
    ];

    expect(() => getAssistantRenderGroups(parts, true)).not.toThrow();

    const groups = getAssistantRenderGroups(parts, true);
    expect(groups.filter((group) => group.kind === "reasoning")).toEqual([]);
    expect(groups.some((group) => group.kind === "text")).toBe(true);
  });

  test("renders even when a text part has no text", () => {
    const parts: UIMessage["parts"] = [
      partWithMissingText("text"),
      { type: "reasoning", text: "still thinking", state: "streaming" },
    ];

    expect(() => getAssistantRenderGroups(parts, true)).not.toThrow();
    expect(getAssistantRenderGroups(parts, true).map((group) => group.kind)).toEqual(["reasoning"]);
  });

  test("does not treat an empty part as prose when aggregating tool calls", () => {
    const parts: UIMessage["parts"] = [
      partWithMissingText("reasoning"),
      {
        type: "dynamic-tool",
        toolName: "bash",
        toolCallId: "c1",
        state: "output-available",
        input: { command: "ls" },
        output: "ok",
      } as UIMessage["parts"][number],
    ];

    expect(() => getAggregateOnlyParts(assistantMessage("m1", parts), true)).not.toThrow();
    expect(getAggregateOnlyParts(assistantMessage("m1", parts), true)?.length).toBe(1);
  });

  test("merges a snapshot whose parts carry no text", () => {
    const snapshot = assistantMessage("m1", [
      partWithMissingText("reasoning"),
      partWithMissingText("text"),
    ]);
    const cached = assistantMessage("m1", [
      { type: "reasoning", text: "longer reasoning", state: "streaming" },
      { type: "text", text: "longer answer", state: "streaming" },
    ]);

    expect(() => mergeSnapshotIntoCachedMessages([snapshot], [cached])).not.toThrow();

    const [merged] = mergeSnapshotIntoCachedMessages([snapshot], [cached]);
    // The cached text is kept when the snapshot arrives empty for that part.
    expect(merged.parts[0]).toMatchObject({ text: "longer reasoning" });
    expect(merged.parts[1]).toMatchObject({ text: "longer answer" });
  });
});
