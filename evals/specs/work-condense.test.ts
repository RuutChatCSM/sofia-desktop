import { expect } from "vitest";
import { test } from "@sofia/testkit";
import { condenseWork, windowLiveWork } from "../../apps/app/src/components/chat/work-condense";
import type { TurnWorkEntry } from "../../apps/app/src/components/chat/turn-presentation";

const thought = (key: string, text = "short"): TurnWorkEntry => ({ kind: "thought", key, text, isStreaming: false, isCurrent: false });
const edit = (key: string): TurnWorkEntry => ({ kind: "milestone", key, parts: [{ type: "tool-edit", toolCallId: key, state: "output-available", input: { filePath: `/a/${key}.ts` }, output: "" }] as never });
const browser = (key: string): TurnWorkEntry => ({
  kind: "detail",
  key,
  item: { index: 0, message: { id: key, role: "assistant", parts: [{ type: "dynamic-tool", toolName: "browser_navigate", toolCallId: key, state: "output-available", input: {}, output: {} }] } } as never,
});

test("short thoughts between edits fold into one thought before one edit run", () => {
  const out = condenseWork([thought("t1"), edit("e1"), thought("t2"), edit("e2"), thought("t3"), edit("e3")]);
  expect(out.map((entry) => entry.kind)).toEqual(["thought", "milestone"]);
  expect(out[0].kind === "thought" && out[0].text).toBe("short\n\nshort\n\nshort");
  expect(out[1].kind === "milestone" && out[1].parts.length).toBe(3);
});

test("repeated browser calls across short thoughts become one capability run", () => {
  const out = condenseWork([browser("b1"), thought("t1"), browser("b2"), thought("t2"), browser("b3")]);
  expect(out.map((entry) => entry.kind)).toEqual(["thought", "capabilityRun"]);
  expect(out[1].kind === "capabilityRun" && out[1].items.length).toBe(3);
});

test("long reasoning, the live phase and commentary still break a run", () => {
  const long = condenseWork([edit("e1"), thought("t1", "x".repeat(700)), edit("e2")]);
  expect(long.map((entry) => entry.kind)).toEqual(["milestone", "thought", "milestone"]);
  const live: TurnWorkEntry = { kind: "thought", key: "t", text: "now", isStreaming: true, isCurrent: true };
  expect(condenseWork([edit("e1"), live]).map((entry) => entry.kind)).toEqual(["milestone", "thought"]);
});

test("a live turn shows its latest six steps behind an earlier-steps count", () => {
  const steps = Array.from({ length: 10 }, (_, index) => index);
  expect(windowLiveWork(steps, true, false)).toEqual({ hidden: 4, visible: [4, 5, 6, 7, 8, 9] });
  expect(windowLiveWork(steps, false, false).hidden).toBe(0);
  expect(windowLiveWork(steps, true, true).hidden).toBe(0);
  expect(windowLiveWork(steps.slice(0, 7), true, false).hidden).toBe(0);
});
