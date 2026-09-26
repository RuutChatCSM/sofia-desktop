import { describe, expect, test } from "bun:test";

import {
  isEvaluatorTraceWarning,
  userFacingWarning,
} from "../src/lib/session-warning";

describe("evaluator state affects behaviour, not product copy", () => {
  test("goal-continuation chatter never ships to normal mode", () => {
    const message =
      "Goal not satisfied — continuing: The agent's final message announces it is about to check the import block";

    expect(isEvaluatorTraceWarning(message)).toBeTrue();
    expect(userFacingWarning(message, false)).toBeNull();
    // Developer mode can still inspect it.
    expect(userFacingWarning(message, true)).toBe(message);
  });

  test("genuinely actionable engine warnings always pass through", () => {
    const held = "This task is open elsewhere. Close it there and retry.";
    const unreadable = "Could not read the transcript. Retry the request.";

    expect(userFacingWarning(held, false)).toBe(held);
    expect(userFacingWarning(unreadable, false)).toBe(unreadable);
  });

  test("empty notices render nothing", () => {
    expect(userFacingWarning(undefined, false)).toBeNull();
    expect(userFacingWarning("   ", false)).toBeNull();
    expect(isEvaluatorTraceWarning("")).toBeFalse();
  });
});
