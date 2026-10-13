import { describe, expect, test } from "bun:test";

import { changedSessionIds } from "../src/react-app/domains/session/sync/transcript-mirror";

describe("transcript mirror dirty sessions", () => {
  test("reports only the entries whose identity changed", () => {
    const untouched = { id: "a" };
    const previous = { a: untouched, b: { id: "b" } };
    const next = { a: untouched, b: { id: "b" }, c: { id: "c" } };

    // `a` is the same object; only `b` (replaced) and `c` (new) are dirty.
    expect(changedSessionIds(next, previous).sort()).toEqual(["b", "c"]);
  });

  test("reports nothing when a stream tick did not touch any session", () => {
    const sessions = { a: { id: "a" } };
    expect(changedSessionIds(sessions, sessions)).toEqual([]);
  });

  test("ignores sessions that were removed", () => {
    expect(changedSessionIds({}, { a: { id: "a" } })).toEqual([]);
  });
});
