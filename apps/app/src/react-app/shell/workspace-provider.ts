import * as React from "react";

import type { SofiaServerClient } from "@/app/lib/sofia-server";
import type { Client } from "@/app/types";

type WorkspaceContextValue = {
  client: Client | null;
  engineBaseUrl: string;
  sofiaServerClient: SofiaServerClient | null;
  workspaceId: string;
  selectedWorkspaceRoot: string;
};

const WorkspaceContext = React.createContext<WorkspaceContextValue | null>(null);

type WorkspaceProviderProps = {
  client: Client | null;
  engineBaseUrl?: string;
  sofiaServerClient?: SofiaServerClient | null;
  workspaceId?: string;
  selectedWorkspaceRoot: string;
  children: React.ReactNode;
};

export function WorkspaceProvider({
  client,
  engineBaseUrl = "",
  sofiaServerClient = null,
  workspaceId = "",
  selectedWorkspaceRoot,
  children,
}: WorkspaceProviderProps) {
  const value = React.useMemo(
    () => ({ client, engineBaseUrl, sofiaServerClient, workspaceId, selectedWorkspaceRoot }),
    [client, engineBaseUrl, sofiaServerClient, workspaceId, selectedWorkspaceRoot],
  );

  return React.createElement(WorkspaceContext.Provider, { value }, children);
}

export function useWorkspace() {
  const context = React.use(WorkspaceContext);

  if (!context) {
    throw new Error("useWorkspace must be used within a WorkspaceProvider");
  }

  return context;
}
