/** @jsxImportSource react */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { DynamicToolUIPart, UIMessage } from "ai";

import { MessageList } from "../src/components/chat/message-list";
import { MessageListProvider } from "../src/components/chat/message-list-provider";
import { turnAnswerIndex } from "../src/components/chat/turn-structure";
import type { ThreadStatus } from "../src/lib/messages";

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

function renderList(messages: UIMessage[], developerMode = false, status: ThreadStatus = "ready") {
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
      <MessageList messages={messages} status={status} />
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
 * The channel the engine marks as commentary is user-visible progress, and it is
 * part of the turn's work: it streams inside the work block while Sofia works and
 * folds away with the rest of the narrative when the answer lands.
 */
const turn: UIMessage[] = [
  tool("c1"),
  commentary("1", PROGRESS_ONE, 2_000),
  tool("c2"),
  commentary("2", PROGRESS_TWO, 3_000),
  tool("c3"),
  finalAnswer(ANSWER),
];

describe("commentary is part of the work", () => {
  test("progress narration streams inside the block and folds away with it", () => {
    const live = renderList([userMessage, ...turn], false, "streaming");
    const finished = renderList([userMessage, ...turn]);

    // While Sofia works the block is open, so the narration is what the user reads.
    expect(live).toContain("reverting the shared background");
    expect(live).toContain("shared Settings wrapper");
    expect((live.match(/data-turn-work-header/g) ?? []).length).toBe(1);
    expect(live).toContain('data-turn-work-header="active"');

    // When the answer lands the same block collapses, and the narration folds
    // away with the rest of the narrative rather than leaving orphaned prose.
    expect(finished).toContain("Worked for");
    expect(finished).not.toContain("reverting the shared background");
    expect(finished).not.toContain("shared Settings wrapper");

    // ...and the answer is still the answer.
    expect(finished).toContain(ANSWER);
  });

  test("collapsed tool detail stays out of the transcript", () => {
    const collapsed = renderList([userMessage, ...turn]);
    const expanded = renderList([userMessage, ...turn], true);

    expect(collapsed).not.toContain("echo c1");
    expect(collapsed).not.toContain("reverting the shared background");
    expect(collapsed).not.toContain("data-tool-aggregate");
    // Opening the block is strictly more content than the collapsed row — the
    // narrative is inspectable, not lost.
    expect(expanded).toContain("reverting the shared background");
    // The tool run is one aggregated row, not one row per command.
    expect((expanded.match(/data-tool-aggregate/g) ?? []).length).toBeGreaterThanOrEqual(1);
    expect(expanded.length).toBeGreaterThan(collapsed.length);
  });

  test("commentary is never mistaken for the final answer", () => {
    // The continuation bug: an earlier message must not answer the turn.
    expect(turnAnswerIndex([commentary("1", PROGRESS_ONE, 1_000)].map((message) => message))).toBe(-1);
    expect(turnAnswerIndex([turn[1]!, turn[3]!])).toBe(-1);
    expect(turnAnswerIndex([turn[5]!])).toBe(0);
  });
});

/**
 * The fixture this regrouping exists for:
 *
 *   commentary A · tool A · commentary B · tool B · commentary C · final_answer
 *
 * One assistant-turn grouping, not a transcript row per protocol item. While the
 * turn runs it is open and the narrative is what the user reads; when the answer
 * arrives the same block collapses to "Worked for …" and only the answer stays
 * outside it; expanding restores the narrative as it streamed.
 */
describe("one assistant turn, one work grouping", () => {
  const narrative: UIMessage[] = [
    commentary("A", PROGRESS_ONE, 2_000),
    tool("a"),
    commentary("B", PROGRESS_TWO, 4_000),
    tool("b"),
    commentary("C", "The layout now matches. I'm running validation.", 6_000),
  ];
  // Substrings without apostrophes: React escapes those in text nodes, and the
  // assertion is about which rows render, not about their escaping.
  const first = "reverting the shared background";
  const second = "shared Settings wrapper";
  const closing = "The layout now matches.";

  test("while live: open, with every update inside the block", () => {
    const markup = renderList([userMessage, ...narrative], false, "streaming");

    expect((markup.match(/data-assistant-turn/g) ?? []).length).toBe(1);
    expect((markup.match(/data-turn-work-header/g) ?? []).length).toBe(1);
    expect(markup).toContain('data-turn-work-header="active"');
    expect(markup).toContain(first);
    expect(markup).toContain(second);
    expect(markup).toContain(closing);
    expect(markup).not.toContain("Worked for");
  });

  test("after the answer: the same block collapses, and only the answer escapes", () => {
    const markup = renderList([userMessage, ...narrative, finalAnswer(ANSWER)]);

    expect((markup.match(/data-assistant-turn/g) ?? []).length).toBe(1);
    expect((markup.match(/data-turn-work-header/g) ?? []).length).toBe(1);
    expect(markup).toContain('data-turn-work-header="done"');
    expect(markup).toContain("Worked for");
    expect(markup).toContain(ANSWER);
    // The narrative went into the block with it — no orphaned progress prose.
    expect(markup).not.toContain(first);
    expect(markup).not.toContain(second);
    expect(markup).not.toContain(closing);
  });

  test("expanding restores the narrative, in the order it streamed", () => {
    const markup = renderList([userMessage, ...narrative, finalAnswer(ANSWER)], true);

    expect(markup).toContain(first);
    expect(markup).toContain(second);
    expect(markup).toContain(closing);
    expect(markup.indexOf(first)).toBeLessThan(markup.indexOf(second));
    expect(markup.indexOf(second)).toBeLessThan(markup.indexOf(closing));
    expect(markup).toContain(ANSWER);
  });

  test("a turn that never answers keeps its only reply visible", () => {
    // A completed turn whose only prose is commentary: folding it into a collapsed
    // "Worked for …" would hide the sole thing Sofia said, which is the failure
    // the ChatGPT reports describe. The block stays open instead.
    const markup = renderList([userMessage, ...narrative]);

    expect((markup.match(/data-assistant-turn/g) ?? []).length).toBe(1);
    expect(markup).toContain(first);
    expect(markup).toContain(second);
    expect(markup).toContain(closing);
  });
});
