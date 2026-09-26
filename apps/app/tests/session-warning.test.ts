import { describe, expect, test } from "bun:test";

import { isEvaluatorTraceWarning, isLongThreadAdvisory, sessionNotice } from "../src/lib/session-warning";

describe("evaluator state affects behaviour, not product copy", () => {
  test("goal-continuation chatter never ships to normal mode", () => {
    const message =
      "Goal not satisfied — continuing: The agent's final message announces it is about to check the import block";

    expect(isEvaluatorTraceWarning(message)).toBeTrue();
    expect(sessionNotice(message, false)).toBeNull();
    // Developer mode can still inspect it, as a warning rather than an advisory.
    expect(sessionNotice(message, true)).toEqual({ kind: "warning", message });
  });

  test("genuinely actionable engine warnings stay warnings", () => {
    const held = "This task is open elsewhere. Close it there and retry.";
    const unreadable = "Could not read the transcript. Retry the request.";

    expect(sessionNotice(held, false)).toEqual({ kind: "warning", message: held });
    expect(sessionNotice(unreadable, false)).toEqual({ kind: "warning", message: unreadable });
  });

  test("empty notices render nothing", () => {
    expect(sessionNotice(undefined, false)).toBeNull();
    expect(sessionNotice("   ", false)).toBeNull();
    expect(isEvaluatorTraceWarning("")).toBeFalse();
  });
});

describe("a long conversation is an advisory, not an incident", () => {
  const engine = "This conversation is getting long. Starting a new chat may help Sofia stay accurate.";

  test("demotes it to info, re-words it for the product, and offers one action", () => {
    expect(isLongThreadAdvisory(engine)).toBeTrue();

    const notice = sessionNotice(engine, false);
    expect(notice?.kind).toBe("info");
    expect(notice?.action).toBe("new-chat");
    // The alarm and the engine's internal vocabulary never reach the product.
    expect(notice?.message).not.toContain("Heads up");
    expect(notice?.message.toLowerCase()).not.toContain("compaction");
  });

  test("an engine still sending the older wording cannot leak it into normal mode", () => {
    // Regression: old builds wrote "Heads up: Long threads and multiple
    // compactions…", which is the copy this redesign exists to remove.
    const legacy =
      "Heads up: Long threads and multiple compactions can cause the model to be less accurate. Start a new thread when possible to keep threads small and targeted.";

    expect(isLongThreadAdvisory(legacy)).toBeTrue();
    const notice = sessionNotice(legacy, false);
    expect(notice?.kind).toBe("info");
    expect(notice?.action).toBe("new-chat");
    expect(notice?.message).not.toContain("Heads up");
    expect(notice?.message.toLowerCase()).not.toContain("compaction");
  });

  test("developer mode keeps the string the engine actually sent", () => {
    expect(sessionNotice(engine, true)?.message).toBe(engine);
  });

  test("other long-conversation phrasings are recognised too", () => {
    expect(isLongThreadAdvisory("This is a long conversation.")).toBeTrue();
    expect(isLongThreadAdvisory("Heads up: Long conversations and multiple compactions can cause the model to be less accurate.")).toBeTrue();
    // A different warning must not be re-labelled as the advisory.
    expect(isLongThreadAdvisory("This task is open elsewhere.")).toBeFalse();
  });

  test("every phrasing normalises to one notice, so a repeat is not new information", () => {
    // The engine sends this after each compaction. Because both wordings fold to
    // the same message, a repeat cannot read as a fresh thing to say — that is
    // what keeps the notice shown once per conversation.
    const legacy =
      "Heads up: Long threads and multiple compactions can cause the model to be less accurate. Start a new thread when possible to keep threads small and targeted.";

    expect(sessionNotice(legacy, false)?.message).toBe(sessionNotice(engine, false)?.message);
  });
});
