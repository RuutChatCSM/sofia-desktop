import { describe, expect, test } from "bun:test";

import {
  PENDING_SESSION_TITLE,
  getDisplaySessionTitle,
  isGeneratedSessionTitle,
} from "../src/app/lib/session-title";

describe("session titles", () => {
  test("the pending Sofia-engine placeholder reads as no title yet", () => {
    // A task the engine has not titled yet must not render "New Sofia task" in
    // the sidebar, and the recovery probe has to keep looking for the real one.
    expect(isGeneratedSessionTitle(PENDING_SESSION_TITLE)).toBe(true);
    expect(isGeneratedSessionTitle(`  ${PENDING_SESSION_TITLE}  `)).toBe(true);
    expect(getDisplaySessionTitle(PENDING_SESSION_TITLE)).not.toBe(PENDING_SESSION_TITLE);
  });

  test("keeps engine-generated and user titles", () => {
    expect(isGeneratedSessionTitle("launch and navigate ruut.chat")).toBe(false);
    expect(getDisplaySessionTitle("launch and navigate ruut.chat")).toBe("launch and navigate ruut.chat");
    expect(isGeneratedSessionTitle("New session - 2026-08-11T10:00:00.000Z")).toBe(true);
    expect(getDisplaySessionTitle("")).not.toBe("");
  });
});
