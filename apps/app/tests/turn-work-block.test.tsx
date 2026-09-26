/** @jsxImportSource react */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { DynamicToolUIPart, UIMessage } from "ai";

import { MessageList } from "../src/components/chat/message-list";
import { MessageListProvider } from "../src/components/chat/message-list-provider";
import type { ThreadStatus } from "../src/lib/messages";

const userMessage: UIMessage = {
  id: "user-1",
  role: "user",
  parts: [{ type: "text", text: "ok can u run the app test", state: "done" }],
};

function bashPart(id: string): UIMessage["parts"][number] {
  return {
    type: "dynamic-tool",
    toolName: "bash",
    toolCallId: id,
    state: "output-available",
    input: { command: `echo ${id}` },
    output: "ok",
  } as UIMessage["parts"][number];
}

function backgroundProcessPart(): DynamicToolUIPart {
  return {
    type: "dynamic-tool",
    toolName: "background_process",
    toolCallId: "call-bg-1",
    state: "input-streaming",
    input: { command: "pnpm --filter @sofia/app test", cwd: "/repo" },
  };
}

/** Other test files can leak a partial `window` stub into a shared worker. */
function withoutWindow<T>(run: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  if (descriptor?.configurable) Reflect.deleteProperty(globalThis, "window");
  try {
    return run();
  } finally {
    if (descriptor?.configurable) Object.defineProperty(globalThis, "window", descriptor);
  }
}

function renderList(messages: UIMessage[], status: ThreadStatus, developerMode = false) {
  return withoutWindow(() =>
    renderToStaticMarkup(
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
    ),
  );
}

describe("progress narration belongs to the work, not the transcript", () => {
  /**
   * A runtime continuation: an earlier message was phased as the final answer,
   * the goal was not satisfied, and the turn kept working. The old grouping took
   * the *first* `final_answer` as the boundary, so every later progress line
   * rendered as standalone transcript prose with the work block collapsed.
   */
  const continuationTurn: UIMessage[] = [
    {
      id: "assistant-1",
      role: "assistant",
      metadata: { engine: { created: 1_000, completed: 4_000, phase: "final_answer" } },
      parts: [{ type: "text", text: "Let me find the evaluator banner...", state: "done" }],
    },
    {
      id: "assistant-2",
      role: "assistant",
      metadata: { engine: { created: 2_000, completed: 3_000, phase: "commentary" } },
      parts: [
        { type: "reasoning", text: "checking", state: "done" },
        { type: "text", text: "Now the core change...", state: "done" },
        bashPart("c1"),
      ],
    },
    {
      id: "assistant-3",
      role: "assistant",
      metadata: { engine: { created: 3_000, completed: 5_000, phase: "final_answer" } },
      parts: [{ type: "text", text: "All done.", state: "done" }],
    },
  ] as UIMessage[];

  test("pre-answer narration folds into the block; the answer stays outside", () => {
    const markup = renderList([userMessage, ...continuationTurn], "ready");
    // While it runs the block is open; the same children are what an expansion
    // shows later, so this is how the narrative is inspected here.
    const running = renderList([userMessage, ...continuationTurn], "streaming");

    // One turn, one work unit.
    expect((markup.match(/data-turn-work-header/g) ?? []).length).toBe(1);
    expect(markup).toContain("Worked for");
    // The final answer is transcript content...
    expect(markup).toContain("All done.");
    // An earlier `final_answer` followed by more work is not this turn's answer,
    // so it stays inside the work block...
    expect(markup).not.toContain("Let me find the evaluator banner");
    // ...and so does `commentary`: it is progress narration the user reads while
    // Sofia works, which means it belongs to the block and folds away with it.
    expect(markup).not.toContain("Now the core change");
    expect(running).toContain("Now the core change");
    expect(markup).not.toContain("Sofia is working…");
  });

  test("a prose-only turn still reports how long it took", () => {
    // Regression: the header derived its clock from the reasoning/tool subset.
    // A turn of pure prose (narration then answer, no reasoning or tool parts)
    // had an empty subset, so a turn Sofia had just executed rendered a bare
    // "Worked" with no duration.
    const proseOnly: UIMessage[] = [
      {
        id: "prose-1",
        role: "assistant",
        metadata: { engine: { created: 5_000, completed: 6_000, phase: "commentary" } },
        parts: [{ type: "text", text: "Let me check the timing path...", state: "done" }],
      },
      {
        id: "prose-2",
        role: "assistant",
        metadata: { engine: { created: 7_000, completed: 95_000, phase: "final_answer" } },
        parts: [{ type: "text", text: "The clock now belongs to the whole turn.", state: "done" }],
      },
    ] as UIMessage[];

    const markup = renderList([userMessage, ...proseOnly], "ready");

    expect(markup).toContain("Worked for 1m 30s");
    expect(markup).not.toContain("Worked<");
    expect(markup).toContain("The clock now belongs to the whole turn.");
    // The block has no tool or reasoning detail here, but the turn still reports
    // its duration, and its narration is inside the disclosure with it.
    expect(markup).not.toContain("Let me check the timing path");
    expect(renderList([userMessage, ...proseOnly], "streaming")).toContain("Let me check the timing path");
  });

  test("the narration is preserved inside the block, not dropped", () => {
    const markup = renderList([userMessage, ...continuationTurn], "streaming");

    expect(markup).toContain("Let me find the evaluator banner");
    expect(markup).toContain("Now the core change");
    expect(markup).toContain("All done.");
  });

  test("collapsed height is header-only however much work it contains", () => {
    // Base UI unmounts a closed panel, so "absent from the collapsed markup" is
    // the markup-level statement of "contributes zero layout height".
    const manyParts = Array.from({ length: 40 }, (_, index) => bashPart(`c${index}`));
    const busyTurn: UIMessage = {
      id: "assistant-busy",
      role: "assistant",
      metadata: { engine: { created: 1_000, completed: 90_000, phase: "final_answer" } },
      parts: [...manyParts, { type: "text", text: "Done with all of it.", state: "done" }],
    } as UIMessage;

    const collapsed = renderList([userMessage, busyTurn], "ready");
    expect((collapsed.match(/data-turn-work-header/g) ?? []).length).toBe(1);
    expect(collapsed).toContain("Worked for");
    expect(collapsed).toContain("Done with all of it.");
    expect(collapsed).not.toContain("background-process-item");
  });
});

describe("one work unit per turn", () => {
  test("a live turn is one open block headed by the semantic activity", () => {
    const assistant: UIMessage = {
      id: "assistant-1",
      role: "assistant",
      metadata: { engine: { created: Date.now() - 84_000 } },
      parts: [
        { type: "reasoning", text: "checking the import block", state: "streaming" },
        backgroundProcessPart(),
      ],
    } as UIMessage;

    const markup = renderList([userMessage, assistant], "streaming");

    // One header: the operation, with elapsed time.
    expect(markup).toContain('data-turn-work-header="active"');
    expect(markup).toContain("Running the app tests");
    expect(markup).toContain("1m 24s");
    // Reasoning stays in the block: never 6 stacked "Thought" rows of its own.
    expect(markup).not.toContain("Thought");
    // The generic fallback never coexists with a work block.
    expect(markup).not.toContain("Sofia is working…");
  });

  test("the generic fallback is the only progress line before any work exists", () => {
    const markup = renderList([userMessage], "submitted");

    expect(markup).toContain("Sofia is working…");
    expect(markup).not.toContain("data-turn-work-header");
  });
});
