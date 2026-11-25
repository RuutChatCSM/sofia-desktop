import { expect } from "vitest";
import { test } from "@sofia/testkit";
import type { SidebarSessionItem } from "../../apps/app/src/app/types";
import {
  SESSIONS_PAGE_SIZE,
  buildSessionTreeState,
  flattenSessionRows,
  nextSessionPreviewCount,
} from "../../apps/app/src/react-app/domains/session/sidebar/utils";

const dated = (id: string, created: number): SidebarSessionItem => ({
  id,
  title: id,
  time: { created, updated: created },
});

const manySessions = (count: number): SidebarSessionItem[] =>
  Array.from({ length: count }, (_unused, index) => dated(`session-${index}`, index + 1));

test("show more advances in pages and clamps to the total", () => {
  expect(SESSIONS_PAGE_SIZE).toBe(50);
  expect(nextSessionPreviewCount(6, 6, 300)).toBe(56);
  expect(nextSessionPreviewCount(56, 56, 300)).toBe(106);
  expect(nextSessionPreviewCount(290, 290, 300)).toBe(300);
  expect(nextSessionPreviewCount(300, 300, 300)).toBe(300);
});

test("a deep active session is rendered as a bounded tail row", () => {
  const sessions = manySessions(300);
  const tree = buildSessionTreeState(sessions, undefined);
  const rows = flattenSessionRows(
    sessions,
    6,
    tree,
    new Set(),
    new Set(),
    new Set(),
    [],
    undefined,
    "session-0",
  );

  expect(rows).toHaveLength(7);
  expect(rows.slice(0, 6).map((row) => row.session.id)).toEqual([
    "session-299",
    "session-298",
    "session-297",
    "session-296",
    "session-295",
    "session-294",
  ]);
  expect(rows[6].session.id).toBe("session-0");
});

test("an active session already inside the page does not add a duplicate row", () => {
  const sessions = manySessions(300);
  const tree = buildSessionTreeState(sessions, undefined);
  const rows = flattenSessionRows(
    sessions,
    6,
    tree,
    new Set(),
    new Set(),
    new Set(),
    [],
    undefined,
    "session-299",
  );

  expect(rows.map((row) => row.session.id)).toEqual([
    "session-299",
    "session-298",
    "session-297",
    "session-296",
    "session-295",
    "session-294",
  ]);
});
