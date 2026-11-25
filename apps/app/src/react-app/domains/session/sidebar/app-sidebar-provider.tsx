/** @jsxImportSource react */
import * as React from "react";
import type { WorkspaceConnectionState } from "../../../../app/types";
import type { SessionNumberShortcutOs } from "../../../shell/session-number-shortcuts";

export type SidebarContextValue = {
  selectedWorkspaceId: string;
  selectedSessionId: string | null;
  developerMode: boolean;
  showSessionActions?: boolean;
  sessionStatusById?: Record<string, string>;
  newTaskDisabled: boolean;
  connectingWorkspaceId: string | null;
  workspaceConnectionStateById: Record<string, WorkspaceConnectionState>;
  onSelectWorkspace: (workspaceId: string) => Promise<boolean> | boolean | void;
  onOpenSession: (workspaceId: string, sessionId: string) => void;
  onPrefetchSession?: (workspaceId: string, sessionId: string) => void;
  onCreateTaskInWorkspace: (workspaceId: string, groupId?: string) => void;
  onOpenRenameSession?: (sessionId: string) => void;
  onOpenDeleteSession?: (sessionId: string) => void;
  onArchiveSession?: (sessionId: string, archived: boolean) => void;
  onOpenCreateGroupModal?: (workspaceId: string) => void;
  onOpenRenameWorkspace: (workspaceId: string) => void;
  onShareWorkspace: (workspaceId: string) => void;
  onRevealWorkspace: (workspaceId: string) => void;
  onRecoverWorkspace: (workspaceId: string) => Promise<boolean> | boolean | void;
  onTestWorkspaceConnection: (workspaceId: string) => Promise<boolean> | boolean | void;
  onEditWorkspaceConnection: (workspaceId: string) => void;
  onForgetWorkspace: (workspaceId: string) => void;
  expandWorkspace: (workspaceId: string) => void;
  toggleWorkspaceExpanded: (workspaceId: string) => void;
  toggleSessionExpanded: (sessionId: string) => void;
  expandedWorkspaceIds: Set<string>;
  expandedSessionIds: Set<string>;
  sessionNumberShortcutOs: SessionNumberShortcutOs;
  sessionNumberShortcutByTarget: ReadonlyMap<string, number>;
};

/**
 * Actions a session row can invoke. Kept in a separate context so status
 * ticks don't invalidate every memoized row through the full sidebar value.
 */
export type SidebarSessionActions = {
  onOpenSession: (workspaceId: string, sessionId: string) => void;
  onPrefetchSession?: (workspaceId: string, sessionId: string) => void;
  onArchiveSession?: (sessionId: string, archived: boolean) => void;
  toggleSessionExpanded: (sessionId: string) => void;
  sessionNumberShortcutOs: SessionNumberShortcutOs;
};

export const SidebarContext = React.createContext<SidebarContextValue | null>(null);
export const SidebarSessionActionsContext = React.createContext<SidebarSessionActions | null>(null);

export function useSidebarContext() {
  const context = React.use(SidebarContext);
  if (!context) throw new Error("useSidebarContext must be used within SidebarProvider");
  return context;
}

export function useSidebarSessionActions() {
  const context = React.use(SidebarSessionActionsContext);
  if (!context) throw new Error("useSidebarSessionActions must be used within SidebarProvider");
  return context;
}
