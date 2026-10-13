import { create } from "zustand";
import { persist } from "zustand/middleware";

// ChatGPT's common summary pin preference is persisted and defaults to true.
export const useSessionSummaryPreferences = create<{
  visible: boolean;
  toggle: () => void;
}>()(
  persist(
    (set) => ({ visible: true, toggle: () => set((state) => ({ visible: !state.visible })) }),
    { name: "sofia-session-summary-preferences", partialize: (state) => ({ visible: state.visible }) },
  ),
);
