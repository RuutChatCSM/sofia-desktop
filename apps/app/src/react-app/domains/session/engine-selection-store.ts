// Engine selection store: which agent engine new sessions use. Codex is the
// default; opencode is switchable only in Settings (the engine picker there is
// the single switch point). Persisted to localStorage AND mirrored to the main
// process (codex-engine-selection.json) so the desktop can gate whether the
// opencode engine boots at startup.
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { codexEngineSelectionWrite } from "@/app/lib/desktop";

export type AgentEngine = "codex" | "opencode";

export const DEFAULT_AGENT_ENGINE: AgentEngine = "codex";

export type EngineSelectionState = {
  engine: AgentEngine;
};

export type EngineSelectionActions = {
  setEngine: (engine: AgentEngine) => void;
};

export type EngineSelectionStore = EngineSelectionState & EngineSelectionActions;

function mirrorToMain(engine: AgentEngine): void {
  try {
    void codexEngineSelectionWrite({ engine });
  } catch {
    // Desktop bridge may be unavailable in web/headless; localStorage persists.
  }
}

export const useEngineSelectionStore = create<EngineSelectionStore>()(
  persist(
    (set) => ({
      engine: DEFAULT_AGENT_ENGINE,
      setEngine: (engine) => {
        set({ engine });
        mirrorToMain(engine);
      },
    }),
    {
      name: "openwork.react.engineSelection",
      storage: createJSONStorage(() => localStorage),
      onRehydrateStorage: () => (state) => {
        // Keep the main process in sync after rehydration too.
        if (state?.engine) mirrorToMain(state.engine);
      },
    },
  ),
);

export function useSelectedEngine(): AgentEngine {
  return useEngineSelectionStore((state) => state.engine);
}

export function useSetSelectedEngine(): (engine: AgentEngine) => void {
  return useEngineSelectionStore((state) => state.setEngine);
}
