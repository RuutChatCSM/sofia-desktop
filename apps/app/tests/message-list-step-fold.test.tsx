/** @jsxImportSource react */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { DynamicToolUIPart, UIMessage } from "ai";

import { MessageList } from "../src/components/chat/message-list";
import { MessageListProvider } from "../src/components/chat/message-list-provider";
import type { ThreadStatus } from "../src/lib/messages";

function bashPart(id: string): DynamicToolUIPart {
  return {
    type: "dynamic-tool",
    toolName: "bash",
    toolCallId: id,
    state: "output-available",
    input: { command: `echo ${id}`, description: "run" },
    output: "ok",
  };
}

function editPart(id: string, filePath: string): DynamicToolUIPart {
  return {
    type: "dynamic-tool",
    toolName: "edit",
    toolCallId: id,
    state: "output-available",
    input: { filePath, oldString: "a", newString: "b" },
    output: "ok",
  };
}

/**
 * Other test files stub `globalThis.window` and can leak it into a shared
 * bun test worker. Static SSR rendering must not see a partial window stub
 * (components probe it for addEventListener), so hide it for the render.
 */
function withoutWindow<T>(run: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  if (descriptor?.configurable) {
    Reflect.deleteProperty(globalThis, "window");
  }
  try {
    return run();
  } finally {
    if (descriptor?.configurable) {
      Object.defineProperty(globalThis, "window", descriptor);
    }
  }
}

function renderList(messages: UIMessage[], developerMode = false, status: ThreadStatus = "ready") {
  return withoutWindow(() => renderToStaticMarkup(
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
    </MessageListProvider>
  ));
}

const userMessage: UIMessage = {
  id: "user-1",
  role: "user",
  metadata: { engine: { created: 1_000 } },
  parts: [{ type: "text", text: "do the thing", state: "done" }],
};

describe("finished turn step fold (single Sofia engine message per turn)", () => {
  test("folds interleaved steps into a 'Worked for …' line and keeps the answer", () => {
    const assistant: UIMessage = {
      id: "assistant-1",
      role: "assistant",
      metadata: { engine: { created: 1_000, completed: 80_000 } },
      parts: [
        { type: "step-start" },
        { type: "reasoning", text: "planning the change", state: "done" },
        bashPart("c1"),
        editPart("c2", "/repo/src/a.ts"),
        { type: "text", text: "Now checking the result:", state: "done" },
        bashPart("c3"),
        bashPart("c4"),
        bashPart("c5"),
        { type: "text", text: "Everything passed — the change is in.", state: "done" },
      ],
    };

    const markup = renderList([userMessage, assistant]);

    // 79 seconds of work between created and completed.
    expect(markup).toContain("Worked for 1m 19s");
    // The answer stays visible outside the fold.
    expect(markup).toContain("Everything passed — the change is in.");
  });

  test("every finished turn gets the same collapsed work block", () => {
    const assistant: UIMessage = {
      id: "assistant-2",
      role: "assistant",
      metadata: { engine: { created: 1_000, completed: 5_000 } },
      parts: [
        { type: "step-start" },
        bashPart("c1"),
        editPart("c2", "/repo/src/a.ts"),
        { type: "text", text: "Done.", state: "done" },
      ],
    };

    const markup = renderList([userMessage, assistant]);

    // Same component, same place, same height as a long turn — the transcript
    // records outcomes, not engine item boundaries.
    expect(markup).toContain("Worked for 4s");
    expect(markup).toContain("Done.");

    // The aggregate summary is the *contents* of the block: inspectable, but
    // folded away once the turn finishes.
    expect(markup).not.toContain("Edited 1 file, ran 1 command");
    // While it runs the block is open, and the same contents are there.
    expect(renderList([userMessage, assistant], false, "streaming")).toContain("Edited 1 file, ran 1 command");
  });

  test("reasoning between calls does not fragment the aggregate", () => {
    const assistant: UIMessage = {
      id: "assistant-3",
      role: "assistant",
      metadata: { engine: { created: 1_000, completed: 4_000 } },
      parts: [
        { type: "step-start" },
        { type: "reasoning", text: "checking the first call", state: "done" },
        bashPart("c1"),
        { type: "reasoning", text: "checking the second call", state: "done" },
        bashPart("c2"),
        { type: "text", text: "Done.", state: "done" },
      ],
    };

    const markup = renderList([userMessage, assistant], false, "streaming");

    expect(markup).toContain("Ran 2 commands");
    // Two commands are still one row: a thought between them does not split the
    // run.
    expect((markup.match(/Ran 2 commands/g) ?? []).length).toBe(1);
    // The thoughts are a collapsed detail inside the work disclosure — one per
    // part, at their place in the narrative — and collapsed by default, so the
    // narrative reads as commentary and milestones rather than as the reasoning
    // behind them.
    expect((markup.match(/>Thought</g) ?? []).length).toBe(2);
  });
});

/** Whether each reasoning block is open, read from its trigger, in order. */
function reasoningBlockStates(markup: string): string[] {
  return markup
    .split("data-reasoning-block")
    .slice(1)
    .map((chunk) => chunk.slice(0, 400))
    .map((chunk) =>
      chunk.includes('aria-expanded="true"')
        ? "open"
        : chunk.includes('aria-expanded="false"')
          ? "closed"
          : "unknown",
    );
}

describe("a thought is a reasoning phase, not a reasoning packet", () => {
  test("the phase in progress is open, and the phases behind it are folded", () => {
    const assistant: UIMessage = {
      id: "assistant-live",
      role: "assistant",
      metadata: { engine: { created: 1_000, turnId: "t1" } },
      parts: [
        { type: "step-start" },
        { type: "reasoning", text: "checking the renderer", state: "done" },
        bashPart("c1"),
        { type: "reasoning", text: "and now the wrapper underneath it", state: "streaming" },
      ],
    };

    const markup = renderList([userMessage, assistant], false, "streaming");

    // She is mid-thought about the second thing, so that phase is open; the one
    // she has already acted on is history and stays folded.
    expect(reasoningBlockStates(markup)).toEqual(["closed", "open"]);
  });

  test("a finished turn leaves every phase folded", () => {
    const assistant: UIMessage = {
      id: "assistant-done",
      role: "assistant",
      metadata: { engine: { created: 1_000, completed: 80_000, turnId: "t1" } },
      parts: [
        { type: "step-start" },
        { type: "reasoning", text: "checking the renderer", state: "done" },
        bashPart("c1"),
        { type: "reasoning", text: "and now the wrapper underneath it", state: "done" },
        { type: "text", text: "Done.", state: "done" },
      ],
    };

    const markup = renderList([userMessage, assistant]);

    // The disclosure is folded, so no phase inside it can be open: a finished
    // turn never drops the reader back into yesterday's thinking.
    expect(markup).toContain("Worked for");
    expect(reasoningBlockStates(markup)).not.toContain("open");
  });
});
