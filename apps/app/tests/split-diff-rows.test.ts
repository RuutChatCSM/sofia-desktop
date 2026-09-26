import { describe, expect, test } from "bun:test";

import { toSplitDiffRows } from "../src/react-app/domains/session/changes/review-pane";
import type { DiffLine } from "../src/react-app/domains/session/changes/turn-change-set";

const context = (oldLine: number, newLine: number, text: string): DiffLine => ({ type: "context", oldLine, newLine, text });
const del = (oldLine: number, text: string): DiffLine => ({ type: "delete", oldLine, text });
const add = (newLine: number, text: string): DiffLine => ({ type: "add", newLine, text });

describe("side-by-side pairing", () => {
  test("pairs a replacement run row by row and pads the shorter side", () => {
    const rows = toSplitDiffRows([
      context(10, 10, "unchanged"),
      del(11, "old one"),
      del(12, "old two"),
      add(11, "new one"),
      context(13, 12, "tail"),
    ]);

    expect(rows.map((row) => [row.old?.text ?? null, row.new?.text ?? null])).toEqual([
      ["unchanged", "unchanged"],
      ["old one", "new one"],
      ["old two", null],
      [null, null], // placeholder guard: the trailing context is its own row
      ["tail", "tail"],
    ].slice(0, 2).concat([
      ["old two", null],
      ["tail", "tail"],
    ]));
  });

  test("context lines appear on both sides with their own numbers", () => {
    const [row] = toSplitDiffRows([context(103, 104, "existing")]);
    expect(row?.old?.oldLine).toBe(103);
    expect(row.new?.newLine).toBe(104);
  });

  test("a pure addition leaves the old side empty", () => {
    const rows = toSplitDiffRows([add(39, "added line")]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.old).toBeUndefined();
    expect(rows[0]?.new?.text).toBe("added line");
  });

  test("a pure deletion leaves the new side empty", () => {
    const rows = toSplitDiffRows([del(105, "removed line")]);
    expect(rows[0]?.new).toBeUndefined();
    expect(rows[0]?.old?.oldLine).toBe(105);
  });
});
