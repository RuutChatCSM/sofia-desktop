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

  test("reasoning is a work entry of its own, ordered before the detail it preceded", () => {
    const items = [
      message("m1", [{ type: "reasoning", text: "thinking about it", state: "done" }, text("Working on it.")]),
      message("m2", [text("Done.")], "final_answer"),
    ];

    const presentation = deriveTurnPresentation(items, true);

    expect(presentation.work.map((entry) => entry.kind)).toEqual(["reasoning", "detail"]);
    const reasoning = presentation.work[0];
    expect(reasoning?.kind === "reasoning" && reasoning.text).toBe("thinking about it");
    const detail = presentation.work[1];
    expect(detail?.kind === "detail" && detail.item.message.id).toBe("m1");
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

    expect(presentation.work.map((entry) => entry.kind)).toEqual(["milestone", "reasoning"]);
    const milestone = presentation.work[0];
    expect(milestone?.kind === "milestone" && milestone.parts).toHaveLength(2);
    const reasoning = presentation.work[1];
    expect(reasoning?.kind === "reasoning" && reasoning.text).toBe("checking");
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
      "reasoning",
      "commentary",
    ]);
    expect(presentation.answerItems.map((item) => item.message.id)).toEqual(["m7"]);

    // Every intermediate message is inside the block, in order — nothing dropped.
    const workText = presentation.work.flatMap((entry) =>
      entry.kind === "commentary" || entry.kind === "detail" ? [entry.item.message.id] : [],
    );
    expect(workText).toEqual(["m1", "m3", "m6"]);
    const reasoning = presentation.work.find((entry) => entry.kind === "reasoning");
    expect(reasoning?.kind === "reasoning" && reasoning.text).toBe("checking the canvas");
  });

  test("reasoning is always part of the narrative, at its own place in it", () => {
    // Reasoning is never gated: it is one of the things the turn did. It sits in
    // chronological order between the commentary and the tools it belongs to.
    const items = [
      message("m1", [text("Let me inspect the shared layout first.")], "commentary"),
      message("m2", [{ type: "reasoning", text: "the wrapper is the culprit", state: "done" }]),
      message("m3", [bash("c1")]),
      message("m4", [text("Done.")], "final_answer"),
    ];

    const presentation = deriveTurnPresentation(items, true);
    expect(presentation.work.map((entry) => entry.kind)).toEqual(["commentary", "reasoning", "milestone"]);

    // With "show thinking" off the reasoning is not in the data at all.
    const withoutThinking = deriveTurnPresentation(items, false);
    expect(withoutThinking.work.map((entry) => entry.kind)).toEqual(["commentary", "milestone"]);
  });
});
