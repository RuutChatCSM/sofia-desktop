import { expect } from "vitest";
import { test } from "@sofia/testkit";
import { turnAnswerIndex, messageTurnId } from "../../apps/app/src/components/chat/turn-structure.ts";
import { codexItemToToolPart } from "../../apps/app/src/react-app/domains/session/sync/codex-item-translator.ts";

function message(id: string, phase?: string) {
  return { id, role: "assistant" as const, metadata: { engine: { turnId: "turn-1", phase } }, parts: [{ type: "text" as const, text: id }] };
}

test("commentary is activity and explicit final answer remains visible", () => {
  expect(turnAnswerIndex([message("checking", "commentary")])).toBe(-1);
  expect(turnAnswerIndex([message("checking", "commentary"), message("done", "final_answer"), message("postscript", "final_answer")])).toBe(1);
  expect(messageTurnId(message("done"))).toBe("turn-1");
});

test("legacy prose followed by a tool is not mistaken for a final answer", () => {
  const tool = { id: "tool", role: "assistant" as const, parts: [{ type: "dynamic-tool" as const, toolName: "bash", toolCallId: "call", state: "input-streaming" as const }] };
  expect(turnAnswerIndex([message("I will inspect it"), tool])).toBe(-1);
  expect(turnAnswerIndex([message("I will inspect it"), tool, message("Done")])).toBe(2);
});

test("completed MCP and dynamic calls stop showing as running and preserve errors", () => {
  expect(codexItemToToolPart({ id: "mcp", type: "mcpToolCall", tool: "search", result: { text: "found" } }, "session", "message", true)).toMatchObject({ state: "output-available", output: '{"text":"found"}' });
  expect(codexItemToToolPart({ id: "dynamic", type: "dynamicToolCall", tool: "run", success: false }, "session", "message", true)).toMatchObject({ state: "output-error" });
});
