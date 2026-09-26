/** @jsxImportSource react */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { UIMessage } from "ai";

import { MessageList } from "../src/components/chat/message-list";
import { MessageListProvider } from "../src/components/chat/message-list-provider";
import { activityTitleForCommand, stripShellWrapper } from "../src/lib/activity-title";
import type { ThreadStatus } from "../src/lib/messages";

const userMessage: UIMessage = {
  id: "user-1",
  role: "user",
  parts: [{ type: "text", text: "ok can u run the app test", state: "done" }],
};

const developerServerMessage: UIMessage = {
  id: "assistant-1",
  role: "assistant",
  parts: [
    {
      type: "dynamic-tool",
      toolName: "background_process",
      toolCallId: "call-bg-1",
      state: "input-streaming",
      input: { command: "pnpm --filter @sofia/app test", cwd: "/Users/mona/Dev/tools/sofia-app" },
    },
  ],
} as UIMessage;

function renderList(messages: UIMessage[], status: ThreadStatus, developerMode = false) {
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

describe("activity titles", () => {
  test("a shell wrapper is never the activity name", () => {
    expect(stripShellWrapper("/bin/zsh -lc 'cd /Users/mona/Dev/tools && pnpm test'")).toBe(
      "cd /Users/mona/Dev/tools && pnpm test",
    );
    expect(activityTitleForCommand("/bin/zsh -lc 'cd /Users/mona/Dev/tools && pnpm --filter @sofia/app test'")).toBe(
      "Running the app tests",
    );
    expect(activityTitleForCommand("pnpm test")).toBe("Running tests");
    expect(activityTitleForCommand("vitest run --coverage")).toBe("Running tests");
    expect(activityTitleForCommand("pnpm dev")).toBe("Running the dev server");
    expect(activityTitleForCommand("pnpm build")).toBe("Building the project");
    expect(activityTitleForCommand("bash -lc 'ls -la'")).not.toMatch(/^bash/i);
  });

  test("the orchestrator's own words win over the command", () => {
    expect(activityTitleForCommand("node reconcile.js", "Preparing the reconciliation")).toBe(
      "Preparing the reconciliation",
    );
    // ...and a blank title falls back to reading the command.
    expect(activityTitleForCommand("pnpm test", "   ")).toBe("Running tests");
  });
});

describe("transcript activity line", () => {
  test("names the operation, never the runtime plumbing", () => {
    const markup = renderList([userMessage, developerServerMessage], "streaming");

    expect(markup).toContain("Running the app tests");
    expect(markup).toContain("ow-text-shimmer");
    expect(markup).not.toContain("Running background process");
    // The semantic phase is what tells the user what is happening, so the
    // generic "Sofia is working…" fallback stays out of the way.
    expect(markup).not.toContain("Sofia is working…");
  });

  test("keeps the terminal command card as a developer detail", () => {
    const plain = renderList([userMessage, developerServerMessage], "streaming");
    expect(plain).not.toContain("background-process-item");

    const developer = renderList([userMessage, developerServerMessage], "streaming", true);
    expect(developer).toContain("background-process-item");
    expect(developer).toContain("pnpm --filter @sofia/app test");
  });
});
