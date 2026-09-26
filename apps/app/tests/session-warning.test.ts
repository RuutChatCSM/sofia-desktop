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
  const engine =
    "Heads up: Long threads and multiple compactions can cause the model to be less accurate. Start a new thread when possible to keep threads small and targeted.";

  test("demotes it to info and offers one action, leaving the engine's words alone", () => {
    expect(isLongThreadAdvisory(engine)).toBeTrue();

    const notice = sessionNotice(engine, false);
    expect(notice?.kind).toBe("info");
    expect(notice?.action).toBe("new-chat");
    // The sentence is the engine's: the app changes how loudly it is said, not
    // what it says.
    expect(notice?.message).toBe(engine);
  });

  test("the register does not depend on developer mode", () => {
    expect(sessionNotice(engine, false)?.kind).toBe("info");
    expect(sessionNotice(engine, true)?.message).toBe(engine);
  });

  test("both wordings the harness has shipped are recognised", () => {
    // core says "threads", the exec reporter says "conversations"; recognising
    // both keeps the register from flipping to a warning if either is in play.
    expect(isLongThreadAdvisory("Heads up: Long conversations and multiple compactions can cause the model to be less accurate.")).toBeTrue();
    expect(sessionNotice("Long threads and multiple compactions can cause the model to be less accurate.", false)?.kind).toBe("info");
    // A different warning must not be re-labelled as the advisory.
    expect(isLongThreadAdvisory("This task is open elsewhere.")).toBeFalse();
    expect(sessionNotice("This task is open elsewhere.", false)?.kind).toBe("warning");
  });
});
