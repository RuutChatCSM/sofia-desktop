import { create } from "zustand";

export type FollowUpMode = "queue" | "steer";
export const FOLLOW_UP_STORAGE_KEY = "sofia:follow-up-mode:v1";

export function readFollowUpMode(): FollowUpMode {
  try {
    return globalThis.localStorage?.getItem(FOLLOW_UP_STORAGE_KEY) === "queue" ? "queue" : "steer";
  } catch {
    return "steer";
  }
}

export const useFollowUpPreference = create<{
  mode: FollowUpMode;
  setMode: (mode: FollowUpMode) => void;
}>((set) => ({
  mode: readFollowUpMode(),
  setMode: (mode) => {
    set({ mode });
    try {
      globalThis.localStorage?.setItem(FOLLOW_UP_STORAGE_KEY, mode);
    } catch {
      // An unavailable storage backend must not prevent submitting a message.
    }
  },
}));
