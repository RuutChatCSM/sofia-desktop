import { describe, expect, test } from "bun:test";

import type { SidebarSessionItem } from "../src/app/types";
import {
  buildSessionTreeState,
  flattenSessionRows,
  orderRootSessions,
} from "../src/react-app/domains/session/sidebar/utils";

const sessions: SidebarSessionItem[] = [
  { id: "session-a", title: "Pinned root" },
  { id: "session-a-child", title: "Pinned child", parentID: "session-a" },
  { id: "session-b", title: "Regular root" },
];

describe("global session pinning", () => {
  test("selects a pinned root and its expanded descendants", () => {
    const tree = buildSessionTreeState(sessions, undefined);
    const rows = flattenSessionRows(
      sessions,
      1,
      tree,
      new Set(["session-a"]),
      new Set(),
      new Set(["session-a"]),
      [],
      { include: new Set(["session-a"]) },
    );

    expect(rows.map((row) => row.session.id)).toEqual(["session-a", "session-a-child"]);
  });

  test("removes pinned roots before applying the workspace preview limit", () => {
    const tree = buildSessionTreeState(sessions, undefined);
    const rows = flattenSessionRows(
      sessions,
      1,
      tree,
      new Set(),
      new Set(),
      new Set(),
      [],
      { exclude: new Set(["session-a"]) },
    );

    expect(rows.map((row) => row.session.id)).toEqual(["session-b"]);
  });
});

const dated = (id: string, created: number): SidebarSessionItem => ({
  id,
  title: id,
  time: { created, updated: created },
});

describe("session recency ordering", () => {
  test("a session appended to the store lands at the top, not the bottom", () => {
    const stored = [dated("old", 1_000), dated("older", 500), dated("brand-new", 2_000)];

    expect(orderRootSessions(stored, new Set(), []).map((session) => session.id)).toEqual([
      "brand-new",
      "old",
      "older",
    ]);
  });

  test("a new session without a manual slot still leads the saved manual order", () => {
    const stored = [dated("second", 2_000), dated("first", 1_000), dated("brand-new", 3_000)];

    expect(orderRootSessions(stored, new Set(), ["first", "second"]).map((session) => session.id)).toEqual([
      "brand-new",
      "first",
      "second",
    ]);
  });

  test("pinned sessions still float above recency order", () => {
    const stored = [dated("old", 1_000), dated("brand-new", 2_000)];

    expect(orderRootSessions(stored, new Set(["old"]), []).map((session) => session.id)).toEqual([
      "old",
      "brand-new",
    ]);
  });
});
