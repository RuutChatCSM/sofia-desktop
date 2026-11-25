import { expect } from "vitest";
import { test } from "@sofia/testkit";
import { liveTurnStatus } from "../../apps/app/src/components/chat/turn-status";

const base = { phase: "working" as const, activityLabel: null, connected: true, elapsed: null, steps: 0, failed: 0 };

test("the live turn header names the real step, its time and its tally", () => {
  expect(liveTurnStatus({ ...base, phase: "thinking", elapsed: "8s" })).toEqual({ title: "Thinking", tone: "thinking", meta: ["8s"] });
  expect(liveTurnStatus({ ...base, activityLabel: "Running pnpm test", elapsed: "42s", steps: 4, failed: 1 })).toEqual({ title: "Running pnpm test", tone: "working", meta: ["42s", "4 steps", "1 failed"] });
  expect(liveTurnStatus({ ...base, phase: "writing", steps: 1 })).toEqual({ title: "Writing the answer", tone: "working", meta: ["1 step"] });
  expect(liveTurnStatus({ ...base, connected: false, activityLabel: "Running pnpm test" }).title).toBe("Reconnecting to Sofia…");
});
