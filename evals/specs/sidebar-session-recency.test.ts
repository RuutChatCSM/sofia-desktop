import { expect } from "vitest";
import { test } from "@sofia/testkit";
import type { SidebarSessionItem } from "../../apps/app/src/app/types";
import {
  buildSessionTreeState,
  flattenSessionRows,
  orderRootSessions,
} from "../../apps/app/src/react-app/domains/session/sidebar/utils";

const dated = (id: string, created: number): SidebarSessionItem => ({
  id,
  title: id,
  time: { created, updated: created },
});

test("a newly appended session renders first and keeps the sidebar inside its preview limit", () => {
  const stored = [
    dated("oldest", 1_000),
    dated("older", 2_000),
    dated("recent", 3_000),
    dated("brand-new-task", 4_000),
  ];

  const ordered = orderRootSessions(stored, new Set(), []);
  expect(ordered.map((session) => session.id)).toEqual([
    "brand-new-task",
    "recent",
    "older",
    "oldest",
  ]);

  const rows = flattenSessionRows(
    ordered,
    3,
    buildSessionTreeState(ordered, undefined),
    new Set(),
    new Set(),
  );
  expect(rows.map((row) => row.session.id)).toEqual(["brand-new-task", "recent", "older"]);
});

test("a new session without a manual slot leads the saved manual order", () => {
  const stored = [dated("second", 2_000), dated("first", 1_000), dated("brand-new-task", 3_000)];

  expect(orderRootSessions(stored, new Set(), ["first", "second"]).map((session) => session.id)).toEqual([
    "brand-new-task",
    "first",
    "second",
  ]);
});
