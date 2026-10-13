import { expect, vi } from "vitest";
import { test } from "@sofia/testkit";
import { resolveSubmitAction } from "../../apps/app/src/react-app/domains/session/surface/composer/submit-action";
import { FOLLOW_UP_STORAGE_KEY, readFollowUpMode, useFollowUpPreference } from "../../apps/app/src/react-app/domains/session/surface/composer/follow-up-preference";

test("idle sends and busy follow-ups honor both preferences and the opposite shortcut", () => {
  for (const mode of ["queue", "steer"] satisfies ("queue" | "steer")[]) {
    expect(resolveSubmitAction({ busy: false, modifier: false, mode })).toBe("send");
    expect(resolveSubmitAction({ busy: false, modifier: true, mode })).toBe("send");
    expect(resolveSubmitAction({ busy: true, modifier: false, mode })).toBe(mode);
    expect(resolveSubmitAction({ busy: true, modifier: true, mode })).toBe(mode === "queue" ? "steer" : "queue");
  }
  expect(resolveSubmitAction({ busy: true, modifier: false })).toBe("steer");
});

test("follow-up preference persists and invalid or unavailable storage defaults to steer", () => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  try {
    expect(readFollowUpMode()).toBe("steer");
    useFollowUpPreference.getState().setMode("queue");
    expect(values.get(FOLLOW_UP_STORAGE_KEY)).toBe("queue");
    expect(readFollowUpMode()).toBe("queue");
    useFollowUpPreference.getState().setMode("steer");
    expect(readFollowUpMode()).toBe("steer");
    values.set(FOLLOW_UP_STORAGE_KEY, "interrupt");
    expect(readFollowUpMode()).toBe("steer");
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("storage unavailable"); }, setItem: () => { throw new Error("storage unavailable"); } });
    expect(readFollowUpMode()).toBe("steer");
    useFollowUpPreference.getState().setMode("queue");
    expect(useFollowUpPreference.getState().mode).toBe("queue");
  } finally {
    vi.unstubAllGlobals();
    useFollowUpPreference.getState().setMode("steer");
  }
});
