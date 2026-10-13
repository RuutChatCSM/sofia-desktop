import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

type Preferences = {
  maximumDimension: number;
  setMaximumDimension: (size: number) => void;
  alwaysHide: boolean;
  hiddenSessions: Record<string, boolean>;
  hide: (sessionId: string) => void;
  hideAll: () => void;
  show: (sessionId: string) => void;
};

export const useComputerPreviewPreferences = create<Preferences>()(persist((set) => ({
  maximumDimension: 200,
  setMaximumDimension: (size) => {
    if (Number.isFinite(size)) set({ maximumDimension: Math.max(200, Math.min(400, size)) });
  },
  alwaysHide: false,
  hiddenSessions: {},
  hide: (sessionId) => set((state) => ({ hiddenSessions: { ...state.hiddenSessions, [sessionId]: true } })),
  hideAll: () => set({ alwaysHide: true }),
  show: (sessionId) => set((state) => ({ alwaysHide: false, hiddenSessions: { ...state.hiddenSessions, [sessionId]: false } })),
}), {
  name: "sofia:computer-preview:v1",
  storage: createJSONStorage(() => localStorage),
  partialize: (state) => ({ maximumDimension: state.maximumDimension, alwaysHide: state.alwaysHide, hiddenSessions: state.hiddenSessions }),
}));
