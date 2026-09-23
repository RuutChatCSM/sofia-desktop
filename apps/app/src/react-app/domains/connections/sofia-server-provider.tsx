/** @jsxImportSource react */
import {
  createContext,
  use,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import type { SofiaServerStore } from "./sofia-server-store";

const SofiaServerContext = createContext<SofiaServerStore | null>(null);

export function SofiaServerProvider(props: {
  store: SofiaServerStore;
  children: ReactNode;
}) {
  return (
    <SofiaServerContext.Provider value={props.store}>
      {props.children}
    </SofiaServerContext.Provider>
  );
}

export function useSofiaServer() {
  const store = use(SofiaServerContext);
  if (!store) {
    throw new Error("useSofiaServer must be used within an SofiaServerProvider");
  }

  useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  return store;
}
