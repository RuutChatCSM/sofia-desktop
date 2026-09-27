import { describe, expect, test } from "bun:test";
import type { DynamicToolUIPart, UIMessage } from "ai";

import {
  deriveTurnPresentation,
  type UIMessageWithIndex,
} from "../src/components/chat/turn-presentation";

function bash(id: string): DynamicToolUIPart {
  return {
    type: "dynamic-tool",
    toolName: "bash",
    toolCallId: id,
    state: "output-available",
    input: { command: `echo ${id}` },
    output: "ok",
  };
}

function edit(id: string): DynamicToolUIPart {
  return {
    type: "dynamic-tool",
    toolName: "edit",
    toolCallId: id,
    state: "output-available",
    input: { filePath: "/repo/a.ts", oldString: "a", newString: "b" },
    output: "ok",
  };
}

function message(id: string, parts: UIMessage["parts"], phase?: "commentary" | "final_answer"): UIMessageWithIndex {
  return {
    index: Number(id.replace(/\D/g, "")),
    message: {
      id,
      role: "assistant",
      metadata: { engine: { turnId: "t1", ...(phase ? { phase } : {}) } },
      parts,
    } as UIMessage,
  };
}

const text = (value: string) => ({ type: "text", text: value, state: "done" }) as UIMessage["parts"][number];

describe("turn presentation", () => {
  test("the whole narrative stays in the work block, in turn order; only the answer escapes", () => {
    // Ran a command → commentary → read/edit → commentary → command → answer.
    const items = [
      message("m1", [bash("c1")]),
      message("m2", [text("I found the mismatch in the shared wrapper.")], "commentary"),
      message("m3", [edit("e1")]),
      message("m4", [text("Aligning the header to the same canvas now.")], "commentary"),
      message("m5", [bash("c2")]),
      message("m6", [text("Done. Removed the background.")], "final_answer"),
    ];

    const presentation = deriveTurnPresentation(items, true);

    // One ordered narrative: a command run, its commentary, the edit run, its
    // commentary, then the final command run. Each run aggregates; commentary
    // interrupts a run rather than joining it.
    expect(presentation.work.map((entry) => entry.kind)).toEqual([
      "milestone",
      "commentary",
      "milestone",
      "commentary",
      "milestone",
    ]);

    // Consecutive tool events inside a run are aggregated, not one row each.
    const firstMilestone = presentation.work[0];
    expect(firstMilestone?.kind === "milestone" && firstMilestone.parts).toHaveLength(1);
    const secondMilestone = presentation.work[2];
    expect(secondMilestone?.kind === "milestone" && secondMilestone.parts).toHaveLength(1);

    // Commentary is part of the narrative, at its own position in it.
    const firstCommentary = presentation.work[1];
    expect(firstCommentary?.kind === "commentary" && firstCommentary.item.message.id).toBe("m2");

    // Commentary never answers the turn.
    expect(presentation.answerItems.map((item) => item.message.id)).toEqual(["m6"]);
  });

  test("one message is projected per part: reasoning, then the prose it precedes", () => {
    const items = [
      message("m1", [{ type: "reasoning", text: "thinking about it", state: "done" }, text("Working on it.")]),
      message("m2", [text("Done.")], "final_answer"),
    ];

    const presentation = deriveTurnPresentation(items, true);

    // The thought and the prose in the same message are two channels, so the
    // narrative can place each where it belongs rather than calling the whole
    // message one opaque "detail".
    expect(presentation.work.map((entry) => entry.kind)).toEqual(["thought", "commentary"]);
    const thought = presentation.work[0];
    expect(thought?.kind === "thought" && thought.text).toBe("thinking about it");
    const commentary = presentation.work[1];
    expect(commentary?.kind === "commentary" && commentary.item.message.id).toBe("m1");
    expect(presentation.answerItems.map((item) => item.message.id)).toEqual(["m2"]);
  });

  test("reasoning inside a run of tool events does not fragment the run", () => {
    // A command, a thought, another command: one aggregate row, and the reasoning
    // follows it rather than splitting it in two.
    const items = [
      message("m1", [bash("c1")]),
      message("m2", [{ type: "reasoning", text: "checking", state: "done" }]),
      message("m3", [bash("c2")]),
      message("m4", [text("Done.")], "final_answer"),
    ];

    const presentation = deriveTurnPresentation(items, true);

    expect(presentation.work.map((entry) => entry.kind)).toEqual(["milestone", "thought"]);
    const milestone = presentation.work[0];
    expect(milestone?.kind === "milestone" && milestone.parts).toHaveLength(2);
    const thought = presentation.work[1];
    expect(thought?.kind === "thought" && thought.text).toBe("checking");
  });

  test("adjacent tool events collapse into one milestone row", () => {
    const items = [
      message("m1", [bash("c1")]),
      message("m2", [edit("e1")]),
      message("m3", [bash("c2")]),
      message("m4", [text("Done.")], "final_answer"),
    ];

    const presentation = deriveTurnPresentation(items, true);

    expect(presentation.work).toHaveLength(1);
    const milestone = presentation.work[0];
    expect(milestone?.kind === "milestone" && milestone.parts).toHaveLength(3);
    expect(presentation.answerItems.map((item) => item.message.id)).toEqual(["m4"]);
  });

  test("commentary, milestones and detail keep their chronology inside one block", () => {
    // The sequence the regrouping exists for: commentary, tool, commentary, tool,
    // reasoning, commentary, answer. None of it may become a transcript sibling.
    const items = [
      message("m1", [text("Let me inspect the shared layout first.")], "commentary"),
      message("m2", [bash("c1")]),
      message("m3", [text("The mismatch comes from the Settings wrapper.")], "commentary"),
      message("m4", [edit("e1")]),
      message("m5", [{ type: "reasoning", text: "checking the canvas", state: "done" }]),
      message("m6", [text("The layout now matches. Running validation.")], "commentary"),
      message("m7", [text("Done. Removed the shared background.")], "final_answer"),
    ];

    const presentation = deriveTurnPresentation(items, true);

    expect(presentation.work.map((entry) => entry.kind)).toEqual([
      "commentary",
      "milestone",
      "commentary",
      "milestone",
      "thought",
      "commentary",
    ]);
    expect(presentation.answerItems.map((item) => item.message.id)).toEqual(["m7"]);

    // Every intermediate message is inside the block, in order — nothing dropped.
    const workText = presentation.work.flatMap((entry) =>
      entry.kind === "commentary" || entry.kind === "detail" ? [entry.item.message.id] : [],
    );
    expect(workText).toEqual(["m1", "m3", "m6"]);
    const thought = presentation.work.find((entry) => entry.kind === "thought");
    expect(thought?.kind === "thought" && thought.text).toBe("checking the canvas");
  });

  test("reasoning sits at its own place in the narrative", () => {
    // Reasoning is never gated behind a mode: it is one of the things the turn
    // did, and it sits in chronological order between the commentary and the
    // tools it belongs to. Whether it is *shown* is the renderer's business.
    const items = [
      message("m1", [text("Let me inspect the shared layout first.")], "commentary"),
      message("m2", [{ type: "reasoning", text: "the wrapper is the culprit", state: "done" }]),
      message("m3", [bash("c1")]),
      message("m4", [text("Done.")], "final_answer"),
    ];

    const presentation = deriveTurnPresentation(items, true);
    expect(presentation.work.map((entry) => entry.kind)).toEqual(["commentary", "thought", "milestone"]);
  });
});

const thinking = (id: string, value: string, state: "done" | "streaming" = "done") =>
  message(id, [{ type: "reasoning", text: value, state }]);

const workTexts = (work: Array<{ kind: string } & Record<string, unknown>>) =>
  work.map((entry) => (entry.kind === "thought" ? (entry.text as string) : entry.kind));

describe("a thought is a reasoning phase, not a reasoning packet", () => {
  test("consecutive packets become one row", () => {
    // The stream arrives in packets — one per model step. The reader should see
    // one reasoning phase, not the runtime's chunk boundaries.
    const items = [
      thinking("m1", "first"),
      thinking("m2", "second"),
      thinking("m3", "third"),
      message("m4", [text("Looking at the shared wrapper now.")], "commentary"),
      message("m5", [text("Done.")], "final_answer"),
    ];

    const presentation = deriveTurnPresentation(items, true);

    expect(presentation.work.map((entry) => entry.kind)).toEqual(["thought", "commentary"]);
    expect(workTexts(presentation.work)).toEqual(["first\n\nsecond\n\nthird", "commentary"]);
  });

  test("commentary, a tool run and the answer each close the phase", () => {
    const items = [
      thinking("m1", "a"),
      thinking("m2", "b"),
      message("m3", [bash("c1")]),
      thinking("m4", "c"),
      message("m5", [text("Running the validation now.")], "commentary"),
      thinking("m6", "d"),
      thinking("m7", "e"),
      message("m8", [text("Done.")], "final_answer"),
    ];

    const presentation = deriveTurnPresentation(items, true);

    // One phase per run of packets, each at its own place in the narrative:
    // never one row per packet, and never hoisted out of chronological order.
    expect(workTexts(presentation.work)).toEqual([
      "a\n\nb",
      "milestone",
      "c",
      "commentary",
      "d\n\ne",
    ]);
  });

  test("only the phase she is in now is current", () => {
    const midThought = deriveTurnPresentation([
      message("m1", [text("Checking the renderer state.")], "commentary"),
      thinking("m2", "still working through it", "streaming"),
    ], true);
    const open = midThought.work.at(-1);
    expect(open?.kind === "thought" && open.isCurrent).toBe(true);

    // A thought she has moved on from is history: a later tool, a later line of
    // prose, or the answer itself all close the phase.
    const movedOn = deriveTurnPresentation([
      thinking("m1", "checking"),
      message("m2", [bash("c1")]),
    ], true);
    expect(movedOn.work.some((entry) => entry.kind === "thought" && entry.isCurrent)).toBe(false);

    const answered = deriveTurnPresentation([
      thinking("m1", "checking", "streaming"),
      message("m2", [text("Done.")], "final_answer"),
    ], true);
    expect(answered.work.some((entry) => entry.kind === "thought" && entry.isCurrent)).toBe(false);
  });
});
