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
  test("milestones and commentary stay visible in turn order; detail collapses", () => {
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

    // Visible: two commentary rows and two aggregated milestones, in order.
    // A command run, its commentary, then the edit run, its commentary, then the
    // final command run — each run aggregates, each commentary interrupts.
    expect(presentation.visible.map((entry) => entry.kind)).toEqual([
      "milestone",
      "commentary",
      "milestone",
      "commentary",
      "milestone",
    ]);

    // Consecutive tool events inside a run are aggregated, not one row each.
    const firstMilestone = presentation.visible[0];
    expect(firstMilestone?.kind === "milestone" && firstMilestone.milestone.parts).toHaveLength(1);
    const secondMilestone = presentation.visible[2];
    expect(secondMilestone?.kind === "milestone" && secondMilestone.milestone.parts).toHaveLength(1);

    // Commentary never lands in the execution trail, and never answers the turn.
    const trailIds = presentation.workItems.map((item) => item.message.id);
    expect(trailIds).not.toContain("m2");
    expect(trailIds).not.toContain("m4");
    expect(presentation.answerItems.map((item) => item.message.id)).toEqual(["m6"]);
  });

  test("reasoning and non-aggregatable detail stay in the collapsed trail", () => {
    const items = [
      message("m1", [{ type: "reasoning", text: "thinking about it", state: "done" }, text("Working on it.")]),
      message("m2", [text("Done.")], "final_answer"),
    ];

    const presentation = deriveTurnPresentation(items, true);

    expect(presentation.workItems.map((item) => item.message.id)).toEqual(["m1"]);
    expect(presentation.visible).toEqual([]);
    expect(presentation.answerItems.map((item) => item.message.id)).toEqual(["m2"]);
  });

  test("adjacent tool events collapse into one milestone row", () => {
    const items = [
      message("m1", [bash("c1")]),
      message("m2", [edit("e1")]),
      message("m3", [bash("c2")]),
      message("m4", [text("Done.")], "final_answer"),
    ];

    const presentation = deriveTurnPresentation(items, true);

    expect(presentation.visible).toHaveLength(1);
    const milestone = presentation.visible[0];
    expect(milestone?.kind === "milestone" && milestone.milestone.parts).toHaveLength(3);
  });
});
