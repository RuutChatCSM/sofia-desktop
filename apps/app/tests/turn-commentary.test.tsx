/** @jsxImportSource react */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { DynamicToolUIPart, UIMessage } from "ai";

import { MessageList } from "../src/components/chat/message-list";
import { MessageListProvider } from "../src/components/chat/message-list-provider";
import { turnAnswerIndex } from "../src/components/chat/turn-structure";

const userMessage: UIMessage = {
  id: "user-1",
  role: "user",
  parts: [{ type: "text", text: "remove the background", state: "done" }],
};

function tool(id: string): UIMessage {
  const part: DynamicToolUIPart = {
    type: "dynamic-tool",
    toolName: "bash",
    toolCallId: id,
    state: "output-available",
    input: { command: `echo ${id}` },
    output: "ok",
  };
  return { id: `tool-${id}`, role: "assistant", metadata: { engine: { turnId: "t1", created: 1_000 } }, parts: [part] } as UIMessage;
}

function commentary(id: string, text: string, created: number): UIMessage {
  return {
    id: `commentary-${id}`,
    role: "assistant",
    metadata: { engine: { turnId: "t1", phase: "commentary", created } },
    parts: [{ type: "text", text, state: "done" }],
  } as UIMessage;
}

function finalAnswer(text: string): UIMessage {
  return {
    id: "final",
    role: "assistant",
    metadata: { engine: { turnId: "t1", phase: "final_answer", created: 9_000, completed: 60_000 } },
    parts: [{ type: "text", text, state: "done" }],
  } as UIMessage;
}

function renderList(messages: UIMessage[], developerMode = false) {
  return renderToStaticMarkup(
    <MessageListProvider
      workspaceId="ws"
      sessionId="session"
      showThinking={true}
      developerMode={developerMode}
      displaySuggestions={false}
      providerConnectedCount={1}
      dispatchAction={() => {}}
      setPrompt={() => {}}
      onRevertToUserMessage={() => {}}
      onForkAtMessage={() => {}}
      onEditUserMessage={() => {}}
      onMcpReconnect={() => Promise.reject(new Error("unused"))}
      onMcpReopenAuthorization={() => Promise.resolve()}
      onMcpRetry={() => {}}
    >
      <MessageList messages={messages} status="ready" />
    </MessageListProvider>,
  );
}

const PROGRESS_ONE =
  "Understood—no page tint. I'm reverting the shared background and aligning the Back head to the same canvas.";
const PROGRESS_TWO =
  "The remaining mismatch comes from the shared Settings wrapper, so I'm fixing that next.";
const ANSWER = "Done. Removed the shared grey background.";

/**
 * tool → commentary → tool → commentary → tools → final_answer
 *
 * The channel the engine marks as commentary is user-visible progress: it must
 * survive the work block, while reasoning and tool detail still collapse.
 */
const turn: UIMessage[] = [
  tool("c1"),
  commentary("1", PROGRESS_ONE, 2_000),
  tool("c2"),
  commentary("2", PROGRESS_TWO, 3_000),
  tool("c3"),
  finalAnswer(ANSWER),
];

describe("commentary is a visible channel", () => {
  test("progress narration survives the collapsed work block", () => {
    const markup = renderList([userMessage, ...turn]);

    // The user can still read what Sofia said while working.
    expect(markup).toContain("reverting the shared background");
    expect(markup).toContain("shared Settings wrapper");

    // The execution detail stays collapsed: the work block is one row and its
    // tool rows are not in the document.
    expect((markup.match(/data-turn-work-header/g) ?? []).length).toBe(1);
    expect(markup).toContain("Worked for");
    expect(markup).not.toContain("echo c1");
    expect(markup).not.toContain("echo c2");
    expect(markup).not.toContain("echo c3");

    // ...and the answer is still the answer.
    expect(markup).toContain(ANSWER);
  });

  test("collapsed tool detail stays out of the transcript", () => {
    const collapsed = renderList([userMessage, ...turn]);
    const expanded = renderList([userMessage, ...turn], true);

    expect(collapsed).not.toContain("echo c1");
    // Opening the block (developer mode defaults it open) is strictly more
    // content than the collapsed row — the detail is inspectable, not lost.
    expect(expanded.length).toBeGreaterThan(collapsed.length);
  });

  test("commentary is never mistaken for the final answer", () => {
    // The continuation bug: an earlier message must not answer the turn.
    expect(turnAnswerIndex([commentary("1", PROGRESS_ONE, 1_000)].map((message) => message))).toBe(-1);
    expect(turnAnswerIndex([turn[1]!, turn[3]!])).toBe(-1);
    expect(turnAnswerIndex([turn[5]!])).toBe(0);
  });
});
