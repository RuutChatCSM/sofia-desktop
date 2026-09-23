import type { SetStateAction } from "react";

export type McpViewLocalState = {
  logoutOpen: boolean;
  logoutTarget: string | null;
  logoutBusy: boolean;
  removeOpen: boolean;
  removeTarget: string | null;
  revealBusy: boolean;
  addMcpModalOpen: boolean;
  togglingMcp: string | null;
};

type McpViewLocalAction<K extends keyof McpViewLocalState = keyof McpViewLocalState> =
  | { type: "set"; key: K; value: SetStateAction<any> };

export const initialMcpViewLocalState: McpViewLocalState = {
  logoutOpen: false,
  logoutTarget: null,
  logoutBusy: false,
  removeOpen: false,
  removeTarget: null,
  revealBusy: false,
  addMcpModalOpen: false,
  togglingMcp: null,
};

export function mcpViewLocalReducer(
  state: McpViewLocalState,
  action: McpViewLocalAction,
): McpViewLocalState {
  switch (action.type) {
    case "set": {
      const current = state[action.key];
      const next =
        typeof action.value === "function"
          ? (action.value as (value: McpViewLocalState[typeof action.key]) => McpViewLocalState[typeof action.key])(current)
          : action.value;
      if (Object.is(current, next)) return state;
      return { ...state, [action.key]: next };
    }
  }
}
