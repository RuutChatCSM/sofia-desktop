import { expect } from "vitest";
import { test } from "@sofia/testkit";
import { commentaryDigest, commentaryNote } from "../../apps/app/src/components/chat/turn-commentary";
import { liveTurnStatus } from "../../apps/app/src/components/chat/turn-status";

test("a narration note is the first sentence as plain one-line text", () => {
  expect(commentaryNote("I'll map the **Traefik** surface across the backend, UI, and docs. Then summarize.")).toBe("I'll map the Traefik surface across the backend, UI, and docs.");
  expect(commentaryNote("Checking `config/routes.rb`\nnext")).toBe("Checking config/routes.rb next");
  expect(commentaryNote("```ts\ncode\n```")).toBe("");
  expect(commentaryNote("x".repeat(300))).toHaveLength(160);
});

test("a settled turn's digest keeps its last three narration lines without repeats", () => {
  expect(commentaryDigest(["One.", "One.", "Two.", "Three.", "Four."])).toEqual(["Two.", "Three.", "Four."]);
  expect(commentaryDigest([])).toEqual([]);
});

test("the live status carries the latest narration as its note", () => {
  const status = liveTurnStatus({ phase: "working", activityLabel: null, connected: true, elapsed: "4s", steps: 2, failed: 0, note: "Mapping the Traefik surface." });
  expect(status).toEqual({ title: "Working", tone: "working", meta: ["4s", "2 steps"], note: "Mapping the Traefik surface." });
});
