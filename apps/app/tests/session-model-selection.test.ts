import { describe, expect, test } from "bun:test";

import {
  resolveSessionModelSelection,
  useSessionModelStore,
} from "../src/react-app/domains/session/surface/session-model-store";

describe("session model resolution", () => {
  test("uses the model selected in the conversation picker instead of a stale fallback", () => {
    const sessionId = "codex-compaction-model-selection";
    useSessionModelStore.getState().setModel(
      sessionId,
      { providerID: "anthropic", modelID: "claude-haiku-4-5" },
      "medium",
    );

    expect(resolveSessionModelSelection(
      sessionId,
      { providerID: "deepseek", modelID: "deepseek-flash" },
      null,
    )).toEqual({
      model: { providerID: "anthropic", modelID: "claude-haiku-4-5" },
      variant: "medium",
    });
  });

  test("falls back only when the conversation has no remembered selection", () => {
    expect(resolveSessionModelSelection(
      "codex-without-model-override",
      { providerID: "xiaomi", modelID: "mimo-v2.5-pro-ultraspeed" },
      "high",
    )).toEqual({
      model: { providerID: "xiaomi", modelID: "mimo-v2.5-pro-ultraspeed" },
      variant: "high",
    });
  });
});
