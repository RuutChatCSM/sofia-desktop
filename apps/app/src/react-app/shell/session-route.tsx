/** @jsxImportSource react */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useLocation, useNavigate } from "react-router";
import { toast } from "@/components/ui/sonner";
import type {
  AgentPartInput,
  FilePartInput,
  ProviderListResponse,
  TextPartInput,
} from "@/app/lib/engine-types";

import { captureAnalyticsEvent, markTaskRunStart } from "@/app/lib/analytics";
import { trackSessionActive, trackTaskStarted } from "@/app/lib/den-telemetry";
import { buildDiagnosticsBundleJson } from "@/app/lib/diagnostics-bundle";
import { downloadTextAsFile } from "@/app/lib/download";
import { canCreateWorkspaces } from "@/app/lib/workspace-creation-policy";
import { createClient, unwrap } from "@/app/lib/engine";
import { abortSessionSafe, forkSession, listCommands, revertSession, setSessionArchived, shellInSession, unrevertSession } from "@/app/lib/engine-session";
import { useSessionManagementStore as sessionManagementStore } from "@/react-app/domains/session/sidebar/session-management-store";
import {
  buildSofiaWorkspaceBaseUrl,
  readSofiaServerSettings,
} from "@/app/lib/sofia-server";
import {
  workspaceServerId,
  type ResolvedWorkspaceEndpoint,
} from "@/app/lib/workspace-endpoint";
import { buildSofiaEnvRuntimeKey } from "@/app/lib/sofia-env-runtime";
import {
  getDesktopHomeDir,
  joinDesktopPath,
  revealDesktopItemInDir,
  pickDirectory,
  resolveWorkspaceListSelectedId,
  workspaceBootstrap,
  workspaceCreateRemote,
  workspaceForget,
  workspaceSetRuntimeActive,
  workspaceSetSelected,
  type SofiaServerInfo,
  type WorkspaceInfo,
  type WorkspaceList,
} from "@/app/lib/desktop";
import type {
  ComposerAttachment,
  ComposerDraft,
  ComposerPart,
  ModelOption,
  ModelRef,
  SlashCommandOption,
  WorkspacePreset,
  WorkspaceConnectionState,
  Client,
  ProviderListItem,
  WorkspaceDisplay,
  WorkspaceSessionGroup,
} from "@/app/types";
import { buildFeedbackUrl } from "@/app/lib/feedback";
import {
  getWorkspaceTaskLoadErrorDisplay,
  isDesktopRuntime,
  isSandboxWorkspace,
  normalizeDirectoryPath,
  normalizeSessionStatus,
  resolveModelDisplayName,
  safeStringify,
} from "@/app/utils";
import { t } from "@/i18n";
import {
  type RouteWorkspace,
  type RouteSession,
  describeRouteError,
  describeWorkspaceCreateError,
  downloadWorkspaceJson,
  folderNameFromPath,
  getSessionStatus,
  isActiveSessionStatus,
  isTransientStartupError,
  mapDesktopWorkspace,
  mergeRouteWorkspaces,
  orderRouteWorkspaces,
  toSessionGroups,
  workspaceExportFilename,
  workspaceLabel,
} from "@/react-app/shell/route-workspaces";
import { useLocal } from "@/react-app/kernel/local-provider";
import { usePlatform } from "@/react-app/kernel/platform";
import { SessionPage, type OpenSessionTab } from "@/react-app/domains/session/chat/session-page";
import { useCodexEngine } from "@/react-app/domains/session/use-codex-engine";
import { useCodexSessionStore } from "@/react-app/domains/session/codex-session-store";
import { useCodexApprovals } from "@/react-app/domains/session/codex/use-codex-approvals";
import { CodexApprovalModal } from "@/react-app/domains/session/codex/codex-approval-modal";
import { ApprovalModeSelector } from "@/react-app/domains/session/codex/approval-mode-selector";
import { createCodexSessionClient, type CodexSession } from "@/app/lib/codex-session";

/** Map a codex session into the engine Session shape the sidebar renders. */
function toRouteSessionFromCodex(session: CodexSession): RouteSession {
  const createdMs = Date.parse(session.created) || Date.now();
  return {
    id: session.id,
    title: session.title,
    time: { created: createdMs, updated: createdMs },
    status: session.status,
    state: { type: session.status },
    workspaceId: session.workspaceId,
    projectID: session.workspaceId,
    directory: "",
    version: "codex",
    slug: session.id,
  } as RouteSession;
}
import { AutomationsPage } from "@/react-app/domains/automations/automations-page";
import { useAutomationDeploymentEnabled } from "@/react-app/domains/automations/automation-availability";
import { automationsStateChangedEvent } from "@/react-app/domains/automations/automation-events";
import type { NewTaskComposerContext } from "@/react-app/domains/session/chat/new-task-composer";
import { isDesktopProviderBlocked } from "@/app/cloud/desktop-app-restrictions";
import { useCheckDesktopRestriction } from "@/react-app/domains/cloud/desktop-config-provider";
import { useRestrictionNotice } from "@/react-app/domains/cloud/restriction-notice-provider";
import { ReactSessionRuntime } from "@/react-app/domains/session/sync/runtime-sync";
import { useSessionActivityStore } from "@/react-app/domains/session/status/session-activity-store";
import { buildSofiaEnvSystemContext } from "@/react-app/domains/session/sync/env-context";
import {
  applySessionRevert,
  applySessionUnrevert,
} from "@/react-app/domains/session/sync/session-sync";
import { firstLineLocalFileParts, joinWorkspaceRelativePath, toFileUrl } from "@/react-app/domains/session/sync/prompt-file-parts";
import { composerAttachmentsToWorkspaceFileParts } from "@/react-app/domains/session/sync/attachment-file-part";
import { useSessionInteractions } from "@/react-app/domains/session/sync/use-session-interactions";
import { useModelBehavior } from "@/react-app/domains/session/surface/use-model-behavior";
import { useSessionFindStore } from "@/react-app/domains/session/surface/find-store";
import { useModelPicker } from "@/react-app/domains/session/modals/use-model-picker";
import { getSessionModelSelection, useSessionModelStore } from "@/react-app/domains/session/surface/session-model-store";
import { openModelPickerEvent, openProviderAuthEvent } from "@/react-app/shell/new-providers-listener";
import { appMentionInstruction } from "@/react-app/domains/session/surface/composer/app-mentions";
import { decodeComposerMentionValue } from "@/react-app/domains/session/surface/composer/mention-encoding";
import { connectSkillPrompt, parseConnectSkillToken } from "@/react-app/domains/session/surface/composer/connect-skill-token";
import { markComposerAutoSend } from "@/react-app/domains/session/surface/composer-auto-send";
import { sendWithRevertRollback } from "@/react-app/domains/session/surface/safe-edit-resend";
import { CreateRemoteWorkspaceModal } from "@/react-app/domains/workspace/create-remote-workspace-modal";
import { CreateWorkspaceModal } from "@/react-app/domains/workspace/create-workspace-modal";
import type { CreateWorkspaceOptions } from "@/react-app/domains/workspace/types";
import { isCloudManagedProviderKey } from "@/react-app/domains/connections/provider-auth/cloud-provider-config";
import { assignedModelOptions } from "@/react-app/domains/connections/provider-auth/assigned-model-options";
import {
  filterEntitledModelOptions,
  resolveEntitledOrgDefaultModel,
  type ModelEntitlementOption,
} from "@/react-app/domains/connections/provider-auth/provider-policy";
import {
  isManagedModelAvailabilityPending,
  isOrganizationModelsEmpty,
  shouldAutoOpenUnavailableModelPicker,
} from "@/react-app/domains/connections/provider-auth/managed-models-recovery";
import { useSessionProviderAuth } from "@/react-app/domains/connections/provider-auth/use-session-provider-auth";
import {
  disabledProvidersFromConfig,
  updateManagedDisabledProviders,
} from "@/react-app/domains/connections/managed-engine-config";
import { useMcpConnectedCount } from "@/react-app/domains/connections/use-mcp-connected-count";
import { useSessionMcpMaintenance } from "@/react-app/domains/connections/use-session-mcp-maintenance";
import { useCloudMcpSubmitReadiness } from "@/react-app/domains/connections/use-cloud-mcp-submit-readiness";
import type { CloudMcpSubmissionResult } from "@/react-app/domains/connections/cloud-mcp-submit-readiness";
import { useRemoteAccessRestart } from "@/react-app/domains/workspace/remote-access-restart";
import { RenameWorkspaceModal } from "@/react-app/domains/workspace/rename-workspace-modal";
import { useRemoteWorkspaceConnectionEditor } from "@/react-app/domains/workspace/use-remote-workspace-connection-editor";
import { useDenAuth } from "@/react-app/domains/cloud/den-auth-provider";
import {
  hasSofiaModelsAvailable,
  shouldShowSofiaModelsSyncing,
} from "@/react-app/domains/cloud/sofia-models-promo";
import {
  diagnoseRemoteWorkspaceTaskLoadFailure,
  getRemoteWorkspaceConnectionKey,
  testRemoteWorkspaceConnection,
} from "@/react-app/domains/workspace/remote-workspace-diagnostics";
import { useShareWorkspaceState } from "@/react-app/domains/workspace/share-workspace-state";
import { ModelPickerModal, MODEL_PICKER_UNAVAILABLE_SUBTITLE } from "@/react-app/domains/session/modals/model-picker-modal";
import { CommandPalette, type PaletteItem, type SessionGroupOption } from "./command-palette";
import { buildCommandPaletteSessions } from "./command-palette-sessions";
import { SessionSearchDialog } from "./session-search-dialog";
import type { SessionMessageFetcher } from "@/react-app/domains/session/search/session-search";
import { useBootState } from "./boot-state";
import {
  forgetWorkspaceMemory,
  readLastSessionFor,
  readWorkspaceProjectDimension,
  readWorkspaceOrderIds,
  writeActiveWorkspaceId,
  writeLastSessionFor,
  writeWorkspaceProjectDimension,
  writeWorkspaceOrderIds,
} from "./session-memory";
import {
  publishInspectorSlice,
  recordInspectorEvent,
} from "../../app/lib/app-inspector";
import { saveSessionDraft } from "@/react-app/domains/session/sync/draft-store";
import { useComposerStateStore } from "@/react-app/domains/session/surface/composer-state-store";
import { useControlAction, type SofiaControlAction } from "./control/control-provider";
import { useReactRenderWatchdog } from "./react-render-watchdog";
import { useBootOverlayVisible } from "./boot-state";

import {
  createDenClient,
  isDenOrgAdminRole,
  readDenSettings,
  type DenOrgRole,
} from "@/app/lib/den";
import { denSessionUpdatedEvent, denSettingsChangedEvent } from "@/app/lib/den-session-events";

import { filterProviderList } from "@/app/utils/providers";
import { ensureDesktopLocalSofiaConnection } from "./desktop-local-sofia";
import { resolveSofiaConnection } from "./sofia-connection";
import { useReloadCoordinator } from "./reload-coordinator";
import { useShellConfig } from "./shell-config";
import { useShellShortcuts } from "./use-shell-shortcuts";
import { useEngineReload } from "./use-engine-reload";
import { useSessionGroupSync } from "./use-session-group-sync";
import { useWorkspaceRouteState } from "./use-workspace-route-state";
import { CloudWorkspaceBootTakeover, useCloudWorkspaceStatus } from "./cloud-workspace-overlay";
import {
  cloudWorkspaceStatusHasReadyContent,
  mapCloudWorkspaceMainContentDecision,
  shouldRefetchCloudWorkspaceOnReadyTransition,
} from "./cloud-workspace-status";
import { getReactQueryClient } from "@/react-app/infra/query-client";
import { useSessionControlActions } from "@/react-app/domains/session/control/session-control-actions";
import { openComposerConfigure, isLibraryAgent, type ComposerSettingsSection } from "@/react-app/domains/settings/library";
import {
  globalExtensionsRoute,
  legacySessionRoute,
  automationsRoute,
  workspaceExtensionsRoute,
  workspaceSessionRoute,
  workspaceSettingsRoute,
} from "./workspace-routes";
import { WorkspaceProvider } from "./workspace-provider";
import type { OpenTarget } from "@/react-app/domains/session/artifacts/open-target";
import { SettingsSurface } from "./settings-route";
import { writeStoredDefaultModel } from "@/react-app/kernel/model-config";
import {
  ensureProviderListQuery,
  getConnectedProviderItems,
  isModelAvailableInConnectedProviders,
  refreshProviderListQueries,
  useProviderListQuery,
} from "@/react-app/infra/provider-list-query";

/**
 * Serialize an SDK error value into a string that parseSessionError can parse.
 * Preserves the original shape (name, data, message) as JSON when possible,
 * so the session surface can detect ProviderModelNotFoundError and offer
 * recovery actions like "Change model".
 */
function serializeSDKError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null) {
    try {
      return JSON.stringify(error);
    } catch {
      const msg = (error as Record<string, unknown>).message;
      return typeof msg === "string" ? msg : String(error);
    }
  }
  return String(error);
}

function describeTaskCreateError(error: unknown) {
  const message = describeRouteError(error);
  let serializedCode: unknown = null;
  try {
    const payload: unknown = JSON.parse(message);
    serializedCode = typeof payload === "object" && payload !== null
      ? Reflect.get(payload, "code")
      : null;
  } catch {
    // The normal error path is plain text, not a wire payload.
  }
  const directCode = typeof error === "object" && error !== null
    ? Reflect.get(error, "code")
    : null;
  const code = typeof directCode === "string" ? directCode : serializedCode;
  if (code === "engine_unconfigured") {
    return "Choose a model for this workspace, then try again.";
  }
  const lower = message.toLowerCase();
  if (
    lower.includes("failed to fetch") ||
    lower.includes("connection") ||
    lower.includes("fetch failed") ||
    lower.includes("econnrefused") ||
    lower.includes("connection lost") ||
    lower.includes("internal_error") ||
    lower.includes("unexpected server error")
  ) {
    return "The engine is unavailable for this workspace. Retry once it restarts, or restart Sofia App if the problem continues.";
  }
  return message;
}

function providerListModelEntitlementOptions(
  providerList: ProviderListResponse | null | undefined,
): ModelEntitlementOption[] {
  return getConnectedProviderItems(providerList).flatMap((provider) =>
    Object.keys(provider.models ?? {}).map((modelID) => ({
      providerID: provider.id,
      modelID,
    })),
  );
}

function taskCreateUnavailableToastId(workspaceId: string) {
  return `engine-unavailable:${workspaceId}`;
}

type CodexProviderWire = {
  providerId: string;
  providerName: string;
  baseUrl: string | null;
  envKey: string | null;
  wireApi: "responses" | "chatcompletions";
  models: Array<{ id: string; name: string; reasoning: boolean; contextWindow: number | null }>;
};

/**
 * Map the app's connected engine providers (models.dev-backed) into the
 * codex-native provider catalog so the bundled Sofia engine's picker shows every
 * model the app can use — including providers connected only via the app auth
 * store. Mirrors codex's `/connect` persistence (providers.json).
 */
function codexProvidersFromProviderList(
  providerList: ProviderListResponse | null | undefined,
): CodexProviderWire[] {
  return getConnectedProviderItems(providerList)
    .filter((provider) => provider.id.trim().toLowerCase() !== "engine")
    .map((provider) => ({
      providerId: provider.id,
      providerName: provider.name?.trim() || provider.id,
      baseUrl: readProviderBaseUrl(provider),
      envKey: null,
      wireApi: provider.id.trim().toLowerCase() === "openai" ? "responses" : "chatcompletions",
      models: Object.entries(provider.models ?? {}).map(([id, model]) => ({
        id,
        name: model.name?.trim() || id,
        reasoning: model.capabilities.reasoning === true,
        contextWindow: model.limit?.context ?? null,
      })),
    }));
}

function readProviderBaseUrl(provider: ProviderListResponse["all"][number]): string | null {
  for (const key of ["baseURL", "baseUrl", "api"]) {
    const value = provider.options?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  // Built-in providers don't put the base URL in `options`; engine resolves
  // it per model from the catalog (`model.api.url`).
  for (const model of Object.values(provider.models ?? {})) {
    const url = model.api?.url;
    if (typeof url === "string" && url.trim()) return url.trim();
  }
  return null;
}

function focusPromptSoon() {
  if (typeof window === "undefined") return;
  const focus = () => window.dispatchEvent(new Event("sofia:focusPrompt"));
  [0, 80, 240, 600].forEach((delay) => window.setTimeout(focus, delay));
}

const EVAL_UNAVAILABLE_PROVIDER_ID = "eval-unavailable-provider";

function nextEvalUnavailableModel(current: ModelRef | null | undefined) {
  return {
    providerID: EVAL_UNAVAILABLE_PROVIDER_ID,
    modelID: current?.providerID === EVAL_UNAVAILABLE_PROVIDER_ID && current.modelID === "eval-unavailable-model-a"
      ? "eval-unavailable-model-b"
      : "eval-unavailable-model-a",
  } satisfies ModelRef;
}

// All workspace-scoped server URLs/clients/tokens come from
// `resolveWorkspaceEndpoint` in apps/app/src/app/lib/workspace-endpoint.ts.
// Don't compose `<baseUrl>/workspace/<id>` here.

async function draftToParts(
  draft: ComposerDraft,
  workspaceRoot: string,
  sessionId: string,
  endpoint: ResolvedWorkspaceEndpoint | null,
) {
  const parts: Array<TextPartInput | FilePartInput | AgentPartInput> = [];
  const root = workspaceRoot.trim();

  const toAbsolutePath = (path: string) => {
    const trimmed = path.trim();
    if (!trimmed) return "";
    if (trimmed.startsWith("/")) return trimmed;
    if (/^[a-zA-Z]:[\\/]/.test(trimmed)) return trimmed;
    if (!root) return "";
    return joinWorkspaceRelativePath(root, trimmed);
  };

  const filenameFromPath = (path: string) => {
    const normalized = path.replace(/\\/g, "/");
    const segments = normalized.split("/").filter(Boolean);
    return segments[segments.length - 1] ?? "file";
  };

  const attachmentFileById = new Map<string, FilePartInput>();
  if (draft.attachments.length > 0) {
    if (!endpoint) {
      throw new Error("Workspace endpoint is unavailable; attachments could not be copied for tool access.");
    }
    const uploaded = await composerAttachmentsToWorkspaceFileParts({
      attachments: draft.attachments,
      endpoint,
      sessionId,
      workspaceRoot: root,
    });
    for (const part of uploaded) {
      if (part.type === "text") {
        parts.push(part);
        continue;
      }
    }
    const fileParts = uploaded.filter((part): part is FilePartInput => part.type === "file");
    for (const [index, attachment] of draft.attachments.entries()) {
      const filePart = fileParts[index];
      if (filePart) attachmentFileById.set(attachment.id, filePart);
    }
  }

  // Prefer draft.text token order so attachment chips stay inline with surrounding text
  // (same positions as the composer), instead of dumping every file part at the end.
  const hasAttachmentTokens = /\[attachment [^\]]+\]/.test(draft.text);
  if (hasAttachmentTokens || attachmentFileById.size > 0) {
    const pasteByLabel = new Map(
      draft.parts
        .filter((part): part is Extract<ComposerPart, { type: "paste" }> => part.type === "paste")
        .map((part) => [part.label, part.text] as const),
    );
    for (const segment of draft.text.split(/(\[attachment [^\]]+\]|\[pasted text [^\]]+\]|\[connect-skill [^\]]+\]|\[skill [^\]]+\]|@[^\s@]+)/)) {
      if (!segment) continue;
      const attachmentMatch = segment.match(/^\[attachment (.+)\]$/);
      if (attachmentMatch?.[1]) {
        const filePart = attachmentFileById.get(attachmentMatch[1]);
        if (filePart) {
          parts.push(filePart);
          attachmentFileById.delete(attachmentMatch[1]);
        }
        continue;
      }
      const pasteMatch = segment.match(/^\[pasted text (.+)\]$/);
      if (pasteMatch?.[1]) {
        const pasted = pasteByLabel.get(pasteMatch[1]);
        if (pasted) parts.push({ type: "text", text: pasted });
        continue;
      }
      const connectSkill = parseConnectSkillToken(segment);
      if (connectSkill) {
        parts.push({ type: "text", text: connectSkillPrompt(connectSkill) });
        continue;
      }
      const skillMatch = segment.match(/^\[skill (.+)\]$/);
      if (skillMatch?.[1]) {
        parts.push({ type: "text", text: `Load [skill ${skillMatch[1]}] and follow its instructions.` });
        continue;
      }
      if (segment.startsWith("@")) {
        const value = decodeComposerMentionValue(segment.slice(1));
        const mentionPart = draft.parts.find((part) =>
          (part.type === "agent" && part.name === value)
          || (part.type === "app" && part.name === value)
          || (part.type === "file" && part.path === value),
        );
        if (mentionPart?.type === "agent") {
          parts.push({ type: "agent", name: mentionPart.name });
          continue;
        }
        if (mentionPart?.type === "app") {
          parts.push({ type: "text", text: appMentionInstruction(mentionPart.name) });
          continue;
        }
        if (mentionPart?.type === "file") {
          const absolute = toAbsolutePath(mentionPart.path);
          if (!absolute) continue;
          parts.push({
            type: "file",
            mime: "text/plain",
            url: toFileUrl(absolute),
            filename: filenameFromPath(mentionPart.path),
          });
          continue;
        }
      }
      parts.push({ type: "text", text: segment });
    }
    for (const filePart of attachmentFileById.values()) {
      parts.push(filePart);
    }
  } else {
    for (const part of draft.parts) {
      if (part.type === "text") {
        parts.push({ type: "text", text: part.text });
        continue;
      }
      if (part.type === "paste") {
        parts.push({ type: "text", text: part.text });
        continue;
      }
      if (part.type === "agent") {
        parts.push({ type: "agent", name: part.name });
        continue;
      }
      if (part.type === "skill") {
        parts.push({ type: "text", text: `Load [skill ${part.name}] and follow its instructions.` });
        continue;
      }
      if (part.type === "app") {
        parts.push({ type: "text", text: appMentionInstruction(part.name) });
        continue;
      }
      if (part.type === "file") {
        const absolute = toAbsolutePath(part.path);
        if (!absolute) continue;
        parts.push({
          type: "file",
          mime: "text/plain",
          url: toFileUrl(absolute),
          filename: filenameFromPath(part.path),
        });
      }
    }
  }

  parts.push(...firstLineLocalFileParts(draft.resolvedText ?? draft.text, root));

  return parts;
}

function singlePickedDirectory(selection: string | string[] | null) {
  return typeof selection === "string"
    ? selection
    : Array.isArray(selection)
      ? selection[0] ?? null
      : null;
}

export function SessionRoute() {
  const navigate = useNavigate();
  const location = useLocation();
  const automationsRouteRequested = /^\/automations(?:\/|$)/.test(location.pathname);
  const platform = usePlatform();
  const denAuth = useDenAuth();
  const { config: shellConfig } = useShellConfig();
  const local = useLocal();
  const automationDeploymentEnabled = useAutomationDeploymentEnabled();
  const automationsEnabled = isDesktopRuntime() && automationDeploymentEnabled;
  const automationsRouteActive = automationsEnabled && automationsRouteRequested;
  const denSettings = readDenSettings();
  const [automationsSupported, setAutomationsSupported] = useState(false);
  const [automationsNeedAttention, setAutomationsNeedAttention] = useState(false);
  useEffect(() => {
    if (!automationsRouteRequested || automationsEnabled) return;
    navigate("/", { replace: true });
  }, [automationsEnabled, automationsRouteRequested, navigate]);
  useEffect(() => {
    const authToken = denSettings.authToken?.trim();
    const organizationId = denSettings.activeOrgId?.trim();
    if (!automationsEnabled || !denAuth.isSignedIn || !authToken || !organizationId) {
      setAutomationsSupported(false);
      setAutomationsNeedAttention(false);
      return;
    }
    let cancelled = false;
    const client = createDenClient({ baseUrl: denSettings.baseUrl, token: authToken });
    const refreshAutomationState = () => {
      void client.listAutomations(organizationId, { limit: 100 })
        .then((result) => {
          if (cancelled) return;
          setAutomationsSupported(true);
          setAutomationsNeedAttention(result.items.some((item) => item.automation.state === "needs_attention"));
        })
        .catch(() => {
          if (cancelled) return;
          setAutomationsSupported(false);
          setAutomationsNeedAttention(false);
        });
    };
    refreshAutomationState();
    const interval = window.setInterval(refreshAutomationState, 5 * 60_000);
    window.addEventListener(automationsStateChangedEvent, refreshAutomationState);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener(automationsStateChangedEvent, refreshAutomationState);
    };
  }, [
    automationsEnabled,
    denAuth.isSignedIn,
    denAuth.status,
    denSettings.activeOrgId,
    denSettings.authToken,
    denSettings.baseUrl,
  ]);
  const automationsNavigationAvailable = automationsEnabled && automationsSupported;
  const reloadCoordinator = useReloadCoordinator();
  const checkDesktopRestriction = useCheckDesktopRestriction();
  const restrictionNotice = useRestrictionNotice();
  const [activeOrganizationRole, setActiveOrganizationRole] = useState<DenOrgRole | null>(null);
  const [sofiaServerHostInfoState, setSofiaServerHostInfoState] = useState<SofiaServerInfo | null>(null);
  const [sofiaServerSettingsVersion, setSofiaServerSettingsVersion] = useState(0);

  const [developerMode, setDeveloperMode] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem("sofia.developerMode") === "1";
  });
  const {
    navigateToWorkspaceSession,
    routeWorkspaceId,
    selectedSessionId,
    loading,
    effectiveLoading,
    client,
    baseUrl,
    token,
    workspaces,
    setWorkspaces,
    workspacesRef,
    workspaceOrderIds,
    setWorkspaceOrderIds,
    workspaceOrderIdsRef,
    sessionsByWorkspaceId,
    setSessionsByWorkspaceId,
    sessionsByWorkspaceIdRef,
    errorsByWorkspaceId,
    setErrorsByWorkspaceId,
    workspaceConnectionOverrides,
    routeError,
    setRouteError,
    legacySelectedWorkspaceId,
    setLegacySelectedWorkspaceId,
    retryingWorkspaceIds,
    setRetryingWorkspaceIds,
    startupRetryTimerRef,
    selectedWorkspaceId,
    selectedWorkspace,
    selectedWorkspaceRoot,
    selectedWorkspaceEndpoint,
    selectedWorkspaceServerToken,
    engineBaseUrl,
    engineClient,
    selectedWorkspaceIsLoading,
    selectedWorkspaceError,
    routeNotFoundMessage,
    endpointForWorkspace,
    refreshRouteState,
    rememberPendingCreatedSession,
    handleRuntimeSessionCreated,
    handleRuntimeSessionUpdated,
    handleRuntimeSessionDeleted,
    handleRemoteWorkspaceConnectionSaved,
    runRemoteWorkspaceConnectionCheck,
  } = useWorkspaceRouteState({
    developerMode,
    workspaceRoute: automationsRouteActive ? "automations" : "session",
    onServerSettingsChanged: () => setSofiaServerSettingsVersion((value) => value + 1),
    onHostInfo: setSofiaServerHostInfoState,
  });
  const cloudWorkspace = useCloudWorkspaceStatus();
  const bootOverlayVisible = useBootOverlayVisible();
  const previousCloudWorkspaceStatusRef = useRef<typeof cloudWorkspace.viewModel.variant | null>(null);
  const codexEngine = useCodexEngine(
    selectedWorkspaceEndpoint
      ? {
          baseUrl: selectedWorkspaceEndpoint.baseUrl,
          token: selectedWorkspaceServerToken ?? "",
          hostToken: selectedWorkspaceEndpoint.isRemote
            ? selectedWorkspace?.sofiaHostToken ?? undefined
            : sofiaServerHostInfoState?.hostToken ?? undefined,
          workspaceId: selectedWorkspaceEndpoint.workspaceId,
          displayWorkspaceId: selectedWorkspaceId,
        }
      : null,
    selectedSessionId,
  );
  const codexApproval = useCodexApprovals(
    codexEngine.enabled ? codexEngine.client : null,
    selectedWorkspaceEndpoint?.workspaceId ?? selectedWorkspaceId,
  );
  useEffect(() => {
    const previousStatus = previousCloudWorkspaceStatusRef.current;
    previousCloudWorkspaceStatusRef.current = cloudWorkspace.viewModel.variant;
    if (!shouldRefetchCloudWorkspaceOnReadyTransition({
      previousStatus,
      nextStatus: cloudWorkspace.viewModel.variant,
      gatewayMode: cloudWorkspace.gatewayMode && cloudWorkspace.visible,
    })) return;
    void refreshRouteState({ supersede: true });
  }, [cloudWorkspace.gatewayMode, cloudWorkspace.viewModel.variant, cloudWorkspace.visible, refreshRouteState]);
  const cloudMcpProviderModel = useMemo(() => local.prefs.defaultModel
    ? {
        provider: local.prefs.defaultModel.providerID,
        model: local.prefs.defaultModel.modelID,
      }
    : undefined, [local.prefs.defaultModel?.modelID, local.prefs.defaultModel?.providerID]);
  const sessionMcpMaintenance = useSessionMcpMaintenance({
    cloudSignedIn: denAuth.isSignedIn,
    client: selectedWorkspaceEndpoint?.client ?? null,
    workspaceId: selectedWorkspaceEndpoint?.workspaceId ?? null,
    engineClient,
    directory: selectedWorkspaceRoot,
    engineReloadBusy: reloadCoordinator.reloadBusy,
    providerModel: cloudMcpProviderModel,
  });
  const {
    state: cloudMcpSubmissionState,
    submit: submitWithCloudMcpReadiness,
    clearFailure: clearCloudMcpSubmissionFailure,
  } = useCloudMcpSubmitReadiness({
    cloudAuthStatus: denAuth.status,
    client: selectedWorkspaceEndpoint?.client ?? null,
    workspaceId: selectedWorkspaceEndpoint?.workspaceId ?? null,
    providerModel: cloudMcpProviderModel,
  });
  // Agent selection is persisted in local prefs (like the model variant) so
  // it survives reloads instead of silently falling back to "build" (#2101).
  const selectedAgent = local.prefs.selectedAgent;
  const setSelectedAgent = useCallback(
    (agent: string | null) => {
      local.setPrefs((previous) => ({ ...previous, selectedAgent: agent }));
    },
    [local.setPrefs],
  );
  // One-way latch for "a refreshRouteState is currently running"; prevents
  // overlapping route refreshes from queueing up when the user clicks fast.
  const [createWorkspaceOpen, setCreateWorkspaceOpen] = useState(false);
  const [createWorkspaceBusy, setCreateWorkspaceBusy] = useState(false);
  const [createWorkspaceError, setCreateWorkspaceError] = useState<string | null>(null);
  const [createWorkspaceRemoteBusy, setCreateWorkspaceRemoteBusy] = useState(false);
  const [createWorkspaceRemoteError, setCreateWorkspaceRemoteError] = useState<string | null>(null);
  const [renameWorkspaceId, setRenameWorkspaceId] = useState<string | null>(null);
  const [renameWorkspaceTitle, setRenameWorkspaceTitle] = useState("");
  const [renameWorkspaceBusy, setRenameWorkspaceBusy] = useState(false);
  const [paletteAccessibleTargets, setPaletteAccessibleTargets] = useState<OpenTarget[]>([]);
  const [providers, setProviders] = useState<ProviderListItem[]>([]);
  const [providerDefaults, setProviderDefaults] = useState<Record<string, string>>({});
  const [providerConnectedIds, setProviderConnectedIds] = useState<string[]>([]);
  const [disabledProviderIds, setDisabledProviderIds] = useState<string[]>([]);
  // Bump to re-filter provider list when den session changes (sign-in/out)
  const [denSessionVersion, setDenSessionVersion] = useState(0);
  useEffect(() => {
    const handler = () => setDenSessionVersion((v) => v + 1);
    window.addEventListener(denSessionUpdatedEvent, handler);
    window.addEventListener(denSettingsChangedEvent, handler);
    return () => {
      window.removeEventListener(denSessionUpdatedEvent, handler);
      window.removeEventListener(denSettingsChangedEvent, handler);
    };
  }, []);

  // Provider IDs that were just added — used to highlight them as
  useEffect(() => {
    setPaletteAccessibleTargets([]);
  }, [selectedSessionId, selectedWorkspaceId]);

  // Provider catalog cache. Used to compute the reasoning/thinking variant
  // options for whichever model is currently selected so the composer's
  // behavior pill actually shows its options (bug: was empty before).

  const sofiaServerSettings = useMemo(
    () => readSofiaServerSettings(),
    [sofiaServerSettingsVersion],
  );

  const activeReloadBlockingSessions = useMemo(
    () =>
      Object.values(sessionsByWorkspaceId)
        .flat()
        .flatMap((session) => {
          if (!isActiveSessionStatus(getSessionStatus(session))) return [];
          const id = String(session?.id ?? "");
          if (!id) return [];
          return [{
            id,
            title:
              String(session?.title ?? session?.slug ?? session?.id ?? "").trim() ||
              t("session.untitled"),
          }];
        }),
    [sessionsByWorkspaceId],
  );
  const activeSelectedWorkspaceSessionIds = useMemo(
    () =>
      (sessionsByWorkspaceId[selectedWorkspaceId] ?? []).flatMap((session) => {
        if (!isActiveSessionStatus(getSessionStatus(session))) return [];
        const id = String(session?.id ?? "").trim();
        return id ? [id] : [];
      }),
    [selectedWorkspaceId, sessionsByWorkspaceId],
  );
  const remoteAccessRestart = useRemoteAccessRestart({
    isEnabled: () => sofiaServerSettings.remoteAccessEnabled === true,
    onHostInfo: setSofiaServerHostInfoState,
    onSettingsChanged: () => setSofiaServerSettingsVersion((value) => value + 1),
  });

  const { engineReloadVersion, routeEngineInfo, reloadWorkspaceEngineFromUi } = useEngineReload({
    client,
    workspaceId: selectedWorkspaceId,
    workspace: selectedWorkspace,
    endpointForWorkspace,
    activeReloadBlockingSessions,
    onError: setRouteError,
    refreshRouteState,
  });

  const environmentRuntimeKey = useMemo(
    () => buildSofiaEnvRuntimeKey({
      baseUrl: client?.baseUrl ?? null,
      pid: sofiaServerHostInfoState?.pid ?? null,
      port: sofiaServerHostInfoState?.port ?? null,
    }),
    [client?.baseUrl, sofiaServerHostInfoState?.pid, sofiaServerHostInfoState?.port],
  );

  const handleApplyEnvironmentChanges = useCallback(async () => {
    if (!isDesktopRuntime()) {
      throw new Error(t("settings.environment.apply_unavailable"));
    }
    if (activeReloadBlockingSessions.length > 0) {
      throw new Error(t("settings.environment.apply_blocked_active_tasks"));
    }
    if (!selectedWorkspaceRoot) {
      throw new Error(t("settings.environment.apply_no_local_workspace"));
    }
    const reloaded = await reloadWorkspaceEngineFromUi();
    if (!reloaded) {
      throw new Error(t("app.error_connect_first"));
    }
  }, [activeReloadBlockingSessions.length, reloadWorkspaceEngineFromUi, selectedWorkspaceRoot]);

  const shareWorkspaceState = useShareWorkspaceState({
    workspaces,
    sofiaServerHostInfo: sofiaServerHostInfoState,
    sofiaServerSettings,
    engineInfo: routeEngineInfo,
    exportWorkspaceBusy: false,
    openLink: (url) => platform.openLink(url),
    workspaceLabel,
  });


  const remoteWorkspaceConnectionEditor = useRemoteWorkspaceConnectionEditor({
    workspaces,
    client,
    onSaved: handleRemoteWorkspaceConnectionSaved,
  });


  const workspaceSessionGroups = useMemo(
    () => toSessionGroups(workspaces, sessionsByWorkspaceId, errorsByWorkspaceId, new Set(retryingWorkspaceIds)),
    [errorsByWorkspaceId, retryingWorkspaceIds, sessionsByWorkspaceId, workspaces],
  );
  // When the selected engine is codex, codex sessions replace engine sessions
  // in the sidebar. Build RouteSession-shaped entries from the codex store.
  const codexWorkspaceSessionGroups = useMemo<WorkspaceSessionGroup[] | null>(() => {
    if (!codexEngine.enabled) return null;
    const codexSessions = codexEngine.sessions;
    return workspaces.map((workspace) => ({
      workspace,
      sessions: codexSessions
        .filter((session) => session.workspaceId === workspace.id)
        .map((session) => toRouteSessionFromCodex(session)),
      status: "ready" as const,
      error: null,
    }));
  }, [codexEngine.enabled, codexEngine.sessions, workspaces]);
  const effectiveWorkspaceSessionGroups = codexWorkspaceSessionGroups ?? workspaceSessionGroups;
  useSessionGroupSync({ workspaces, endpointForWorkspace });
  const selectedWorkspaceGroupState = sessionManagementStore((state) => (
    selectedWorkspaceId ? state.groupsByWorkspace[selectedWorkspaceId] : undefined
  ));
  const assignSessionToGroup = sessionManagementStore((state) => state.assignGroup);
  const seedWorkspaceActivitySessions = useSessionActivityStore((state) => state.seedWorkspaceSessions);
  const sessionActivityByWorkspaceId = useSessionActivityStore((state) => state.statusesByWorkspaceId);

  useEffect(() => {
    for (const group of workspaceSessionGroups) {
      seedWorkspaceActivitySessions(group.workspace.id, group.sessions);
      const serverId = workspaceServerId(group.workspace);
      if (serverId && serverId !== group.workspace.id) {
        seedWorkspaceActivitySessions(serverId, group.sessions);
      }
    }
  }, [seedWorkspaceActivitySessions, workspaceSessionGroups]);

  const sidebarSessionStatusById = useMemo(() => {
    const next: Record<string, string> = {};
    for (const group of workspaceSessionGroups) {
      const serverId = workspaceServerId(group.workspace);
      const workspaceStatuses = {
        ...(sessionActivityByWorkspaceId[group.workspace.id] ?? {}),
        ...(serverId ? sessionActivityByWorkspaceId[serverId] ?? {} : {}),
      };
      for (const session of group.sessions) {
        const status = workspaceStatuses[session.id];
        if (status) next[session.id] = status;
      }
    }
    return next;
  }, [sessionActivityByWorkspaceId, workspaceSessionGroups]);

  const sidebarActiveWorkspaceId = useMemo(() => {
    const sessionId = selectedSessionId?.trim() ?? "";
    if (sessionId) {
      const owner = workspaceSessionGroups.find((group) =>
        group.sessions.some((session) => session?.id === sessionId),
      );
      if (owner?.workspace.id) return owner.workspace.id;
    }
    return selectedWorkspaceId;
  }, [selectedSessionId, selectedWorkspaceId, workspaceSessionGroups]);

  const workspaceConnectionStateById = useMemo(() => {
    const next: Record<string, WorkspaceConnectionState> = { ...workspaceConnectionOverrides };
    for (const workspace of workspaces) {
      if (workspace.workspaceType !== "remote") continue;
      const error = errorsByWorkspaceId[workspace.id]?.trim();
      if (!error || next[workspace.id]?.status === "connecting") continue;
      next[workspace.id] ??= {
        status: "error",
        message: getWorkspaceTaskLoadErrorDisplay(workspace, error).message || error,
        checkedAt: null,
      };
    }
    return next;
  }, [errorsByWorkspaceId, workspaceConnectionOverrides, workspaces]);

  const mcpConnectedCount = useMcpConnectedCount(engineClient, selectedWorkspaceRoot);
  const providerListQuery = useProviderListQuery({
    client: engineClient,
    baseUrl: engineBaseUrl,
    directory: selectedWorkspaceRoot || undefined,
  });
  // Sofia's native provider store owns its catalog. Never overwrite it with
  // Sofia's independently discovered models during a render/refetch.
  const { providerCatalog, modelVariantLabel, modelBehaviorOptions, modelVariantValue } =
    useModelBehavior({
      providerList: providerListQuery.data,
      defaultModel: local.prefs.defaultModel,
      modelVariant: local.prefs.modelVariant ?? null,
    });
  const {
    store: sessionProviderAuthStore,
    snapshot: sessionProviderAuthSnapshot,
    cloudProviderSyncReady,
    cloudProviderList,
    refreshCloudProviderSync,
  } = useSessionProviderAuth({
    engineClient,
    engineBaseUrl,
    providers,
    providerDefaults,
    providerConnectedIds,
    disabledProviderIds,
    selectedWorkspace,
    selectedWorkspaceEndpoint,
    selectedWorkspaceRoot,
    selectedWorkspaceId,
    localServerHostToken: sofiaServerHostInfoState?.hostToken?.trim() ?? "",
    setProviders,
    setProviderDefaults,
    setProviderConnectedIds,
    setDisabledProviderIds,
  });
  const organizationAssignedModelOptions = useMemo(
    () => assignedModelOptions(sessionProviderAuthSnapshot.cloudOrgProviders),
    [sessionProviderAuthSnapshot.cloudOrgProviders],
  );
  useEffect(() => {
    if (!denAuth.isSignedIn) {
      setActiveOrganizationRole(null);
      return;
    }

    const settings = readDenSettings();
    const tokenValue = settings.authToken?.trim() ?? "";
    const activeOrgId = settings.activeOrgId?.trim() ?? "";
    const activeOrgSlug = settings.activeOrgSlug?.trim() ?? "";
    if (!tokenValue || (!activeOrgId && !activeOrgSlug)) {
      setActiveOrganizationRole(null);
      return;
    }

    let cancelled = false;
    void createDenClient({ baseUrl: settings.baseUrl, token: tokenValue })
      .listOrgs()
      .then((response) => {
        if (cancelled) return;
        const active = response.orgs.find((org) =>
          org.id === activeOrgId || org.slug === activeOrgSlug,
        );
        setActiveOrganizationRole(active?.role ?? null);
      })
      .catch(() => {
        if (!cancelled) setActiveOrganizationRole(null);
      });

    return () => {
      cancelled = true;
    };
  }, [denAuth.isSignedIn, denAuth.status, denSessionVersion]);
  const handleModelPickerOpen = useCallback(() => {
    void refreshCloudProviderSync("model_picker_open");
  }, [refreshCloudProviderSync]);
  const sofiaModelsEntitled = useMemo(() => {
    if (!denAuth.isSignedIn) return false;
    const fromOrg = sessionProviderAuthSnapshot.cloudOrgProviders.some(
      (provider) =>
        [provider.providerId, provider.source].some(
          (value) => value?.trim().toLowerCase() === "sofia",
        ),
    );
    const fromImport = Object.values(sessionProviderAuthSnapshot.importedCloudProviders ?? {}).some(
      (provider) =>
        [provider.providerId, provider.source, provider.sourceProviderId].some(
          (value) => value?.trim().toLowerCase() === "sofia",
        ),
    );
    return fromOrg || fromImport;
  }, [
    denAuth.isSignedIn,
    sessionProviderAuthSnapshot.cloudOrgProviders,
    sessionProviderAuthSnapshot.importedCloudProviders,
  ]);
  const refreshOrganizationModelAccess = useCallback(async () => {
    await refreshCloudProviderSync("manual");
  }, [refreshCloudProviderSync]);
  useEffect(() => {
    if (!cloudProviderSyncReady || !cloudProviderList) return;
    clearCloudMcpSubmissionFailure();
  }, [clearCloudMcpSubmissionFailure, cloudProviderList, cloudProviderSyncReady]);
  const organizationModelsSettingsUrl = useMemo(() => {
    if (!isDenOrgAdminRole(activeOrganizationRole)) {
      return undefined;
    }
    return new URL("/dashboard/custom-llm-providers", readDenSettings().baseUrl).toString();
  }, [activeOrganizationRole, denSessionVersion]);
  const restrictToCloudProviders = checkDesktopRestriction({ restriction: "allowCustomProviders" });
  const entitledModelOptions = useMemo(() => {
    const runtimeOptions = providerListModelEntitlementOptions(
      cloudProviderList ?? providerListQuery.data,
    );
    return filterEntitledModelOptions(
      runtimeOptions.length > 0 ? runtimeOptions : organizationAssignedModelOptions,
      {
        restrictToCloud: restrictToCloudProviders,
        checkRestriction: checkDesktopRestriction,
      },
    );
  }, [
    checkDesktopRestriction,
    cloudProviderList,
    organizationAssignedModelOptions,
    providerListQuery.data,
    restrictToCloudProviders,
  ]);
  const sofiaModelsAvailable = hasSofiaModelsAvailable({
    providerConnectedIds,
    providers,
  });
  const sofiaModelsSyncing = shouldShowSofiaModelsSyncing({
    entitled: sofiaModelsEntitled,
    available: sofiaModelsAvailable,
    workspaceReady: Boolean(selectedWorkspaceId && engineClient),
    reloadPending: sessionProviderAuthSnapshot.cloudProviderServerSync?.reloadPending === true,
  });
  const organizationModelsEmpty = isOrganizationModelsEmpty({
    workspaceReady: Boolean(selectedWorkspaceId && engineClient),
    loading,
    restrictToCloud: restrictToCloudProviders,
    cloudProviderSyncReady,
    entitledModelCount: entitledModelOptions.length,
  });
  const modelPicker = useModelPicker({
    client: engineClient,
    baseUrl: engineBaseUrl,
    workspaceRoot: selectedWorkspaceRoot,
    onOpen: handleModelPickerOpen,
    fallbackOptions: organizationAssignedModelOptions,
    cloudProvidersEnabled: denAuth.isSignedIn,
    // Engine-aware: the codex engine offers only the providers its runtime is
    // configured with; the engine engine offers all connected providers.
    engine: codexEngine.enabled ? "codex" : "engine",
    codexProviders: codexEngine.config?.providers ?? [],
    codexProviderIds: codexEngine.config?.providers.map((provider) => provider.providerId) ?? [],
  });
  // Which session the open model picker targets. Selecting a model while a
  // session is targeted remembers it for that conversation only; null means
  // the picker edits the global default (e.g. opened from the new-providers
  // toast). Composer "All models" carries the session id on the open event.
  const [modelPickerSessionId, setModelPickerSessionId] = useState<string | null>(null);
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: string }>).detail;
      setModelPickerSessionId(typeof detail?.sessionId === "string" ? detail.sessionId : null);
    };
    window.addEventListener(openModelPickerEvent, handler);
    return () => window.removeEventListener(openModelPickerEvent, handler);
  }, []);
  const selectedModelUsesCloudProvider = Boolean(
    local.prefs.defaultModel && isCloudManagedProviderKey(local.prefs.defaultModel.providerID),
  );
  const selectedModelProviderList = selectedModelUsesCloudProvider
    ? cloudProviderList
    : providerListQuery.data;
  const entitledOrgDefaultModel = useMemo(() => {
    const runtimeOptions = providerListModelEntitlementOptions(
      cloudProviderList ?? providerListQuery.data,
    );
    return resolveEntitledOrgDefaultModel(
      runtimeOptions.length > 0 ? runtimeOptions : organizationAssignedModelOptions,
      {
        currentDefault: local.prefs.defaultModel,
        restrictToCloud: restrictToCloudProviders,
        checkRestriction: checkDesktopRestriction,
      },
    );
  }, [
    checkDesktopRestriction,
    cloudProviderList,
    local.prefs.defaultModel,
    organizationAssignedModelOptions,
    providerListQuery.data,
    restrictToCloudProviders,
  ]);
  useEffect(() => {
    if (entitledOrgDefaultModel) writeStoredDefaultModel(entitledOrgDefaultModel);
  }, [entitledOrgDefaultModel]);
  useEffect(() => {
    const config = codexEngine.config;
    if (!codexEngine.enabled || !config?.defaultProviderId || !config.model) return;
    if (local.prefs.defaultModel?.providerID && local.prefs.defaultModel.modelID) return;
    local.setPrefs((previous) => ({ ...previous, defaultModel: { providerID: config.defaultProviderId!, modelID: config.model! } }));
  }, [codexEngine.enabled, codexEngine.config, local.prefs.defaultModel, local.setPrefs]);
  const selectedModelAvailabilityPending = codexEngine.enabled ? !codexEngine.config : isManagedModelAvailabilityPending({
    signedIn: denAuth.isSignedIn,
    selectedModelUsesCloudProvider,
    cloudProviderSyncReady,
    sofiaModelsSyncing,
  });
  const selectedModelUnavailable = codexEngine.enabled
    ? Boolean(codexEngine.config && local.prefs.defaultModel &&
        (!codexEngine.config.providers.some((provider) => provider.providerId === local.prefs.defaultModel?.providerID) ||
          isDesktopProviderBlocked({ providerId: local.prefs.defaultModel.providerID, checkRestriction: checkDesktopRestriction })))
    : Boolean(
    selectedWorkspaceId &&
      engineClient &&
      !loading &&
      !selectedModelAvailabilityPending &&
      local.prefs.defaultModel &&
      (!selectedModelUsesCloudProvider || cloudProviderSyncReady) &&
      (
        isDesktopProviderBlocked({
          providerId: local.prefs.defaultModel.providerID,
          checkRestriction: checkDesktopRestriction,
        }) ||
        (
          selectedModelProviderList &&
          restrictToCloudProviders &&
          !selectedModelProviderList.connected.some(
            (providerId) => providerId.trim() === local.prefs.defaultModel?.providerID.trim(),
          )
        ) ||
        (
          selectedModelProviderList &&
          !isModelAvailableInConnectedProviders(selectedModelProviderList, local.prefs.defaultModel)
        )
      ),
  );
  const selectedModelUnavailableKey = selectedModelUnavailable && local.prefs.defaultModel
    ? `${local.prefs.defaultModel.providerID}:${local.prefs.defaultModel.modelID}`
    : null;
  // A conversation can remember its own model. Judge the composer on THAT
  // model rather than the global default: otherwise reopening a task whose
  // conversation model is still valid shows "model unavailable" merely because
  // the global default was pointed at a provider this engine doesn't serve.
  const selectedSessionOwnModel = useSessionModelStore((state) =>
    selectedSessionId ? state.bySessionId[selectedSessionId]?.model ?? null : null,
  );
  const selectedSessionModelUnavailable = codexEngine.enabled && selectedSessionOwnModel
    ? Boolean(
        codexEngine.config &&
          (!codexEngine.config.providers.some(
            (provider) => provider.providerId === selectedSessionOwnModel.providerID,
          ) ||
            isDesktopProviderBlocked({
              providerId: selectedSessionOwnModel.providerID,
              checkRestriction: checkDesktopRestriction,
            })),
      )
    : selectedModelUnavailable;

  const autoOpenedUnavailableModelRef = useRef<string | null>(null);

  useEffect(() => {
    if (!selectedModelUnavailableKey) {
      autoOpenedUnavailableModelRef.current = null;
      return;
    }
    if (!shouldAutoOpenUnavailableModelPicker({
      selectedModelUnavailableKey,
      signedIn: denAuth.isSignedIn,
      cloudProviderSyncReady,
      entitledOrgDefaultModel: Boolean(entitledOrgDefaultModel),
      organizationModelsEmpty,
      autoOpenedUnavailableModelKey: autoOpenedUnavailableModelRef.current,
    })) return;
    if (entitledOrgDefaultModel) {
      writeStoredDefaultModel(entitledOrgDefaultModel);
      return;
    }

    autoOpenedUnavailableModelRef.current = selectedModelUnavailableKey;
    modelPicker.setQuery("");
    modelPicker.setRecentProviderIds(new Set());
    modelPicker.setCompactOpen(false);
    modelPicker.setOpen(true);
  }, [cloudProviderSyncReady, denAuth.isSignedIn, entitledOrgDefaultModel, modelPicker.setCompactOpen, modelPicker.setOpen, modelPicker.setQuery, modelPicker.setRecentProviderIds, organizationModelsEmpty, selectedModelUnavailableKey]);

  const hasUsableModel = Boolean(
    local.prefs.defaultModel &&
      !selectedModelUnavailable &&
      !selectedModelAvailabilityPending,
  );
  const codexHasModel = Boolean(codexEngine.enabled && codexEngine.config?.defaultProviderId);
  const canCreateTask = codexEngine.enabled
    ? Boolean(
        codexHasModel &&
          selectedWorkspaceId &&
          !loading &&
          !selectedWorkspaceError,
      )
    : Boolean(
        engineClient &&
          selectedWorkspaceId &&
          !loading &&
          !selectedWorkspaceError &&
          !selectedModelUnavailable &&
          !selectedModelAvailabilityPending,
      );

  const {
    activePermission,
    permissionReplyBusy,
    respondPermission,
    activeQuestion,
    questionReplyBusy,
    respondQuestion,
    todos,
  } = useSessionInteractions({
    client: engineClient,
    workspaceId: selectedWorkspaceId,
    sessionId: selectedSessionId,
    workspaceRoot: selectedWorkspaceRoot,
  });
  const modelUnavailableMessage = organizationModelsEmpty
    ? t("models.organization_models_empty")
    : selectedModelUnavailable
      ? t("models.model_unavailable_short")
      : null;
  const showPreparingStatus =
    !organizationModelsEmpty &&
    (effectiveLoading ||
      selectedModelAvailabilityPending ||
      (!canCreateTask && !routeError && !selectedWorkspaceError));

  useEffect(() => {
    if (!engineClient) {
      setProviders([]);
      setProviderDefaults({});
      setProviderConnectedIds([]);
      return;
    }

    let cancelled = false;

    const applyProviderState = (value: ProviderListResponse) => {
      if (cancelled) return;
      // When not signed in, filter out every cloud-managed provider key so
      // stale org imports and the hosted `sofia` catalog do not reappear.
      const hasCloudAuth = !!readDenSettings().authToken?.trim();
      const all = hasCloudAuth
        ? ((value.all ?? []) as ProviderListItem[])
        : ((value.all ?? []) as ProviderListItem[]).filter(
            (provider) => !isCloudManagedProviderKey(provider.id ?? ""),
          );
      const connected = hasCloudAuth
        ? (value.connected ?? [])
        : (value.connected ?? []).filter((id) => !isCloudManagedProviderKey(id));
      setProviders(all);
      setProviderConnectedIds(connected);
      // New-provider detection is handled globally by the provider auth
      // store's applyProviderListState, which fires dispatchNewProviders.
    };

    void (async () => {
      let disabledProviders: string[] = [];
      try {
        const config = unwrap(
          await engineClient.config.get({
            directory: selectedWorkspaceRoot || undefined,
          }),
        );
        disabledProviders = disabledProvidersFromConfig(config);
        if (!cancelled) setDisabledProviderIds(disabledProviders);
      } catch {
        // ignore config read failures and continue with provider discovery
      }

      try {
        applyProviderState(
          filterProviderList(
            await ensureProviderListQuery(getReactQueryClient(), {
              client: engineClient,
              baseUrl: engineBaseUrl,
              directory: selectedWorkspaceRoot || undefined,
            }),
            disabledProviders,
          ),
        );
      } catch {
        if (cancelled) return;
        setProviders([]);
        setProviderDefaults({});
        setProviderConnectedIds([]);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [engineBaseUrl, engineClient, selectedWorkspaceRoot, denSessionVersion]);

  const modelLabel = local.prefs.defaultModel
    ? resolveModelDisplayName(local.prefs.defaultModel.modelID)
    : t("session.default_model");

  const listSlashCommands = useCallback(async (): Promise<SlashCommandOption[]> => {
    // engineReloadVersion is included so the callback identity changes after
    // an engine reload, which invalidates the composer's command list cache
    // and causes it to re-fetch (picking up newly created skills).
    void engineReloadVersion;
    if (!engineClient) return [];
    return listCommands(engineClient, selectedWorkspaceRoot || undefined);
  }, [engineReloadVersion, engineClient, selectedWorkspaceRoot]);

  // Shared by the composer (plug menu, @ mentions) and the command palette.
  // Hidden and subagent-only entries are excluded — those are task-tool
  // delegation targets, not agents the user can run a session as.
  const listAgents = useCallback(async () => {
    // Include engineReloadVersion so the composer refetches after newly added
    // agent files become available, even when the inline picker is hidden.
    void engineReloadVersion;
    if (!engineClient) return [];
    const list = unwrap(await engineClient.app.agents());
    return list.filter(isLibraryAgent);
  }, [engineReloadVersion, engineClient]);

  const handleOpenSettings = useCallback((route = "/settings/general", workspaceId = sidebarActiveWorkspaceId) => {
    const sessionId = workspaceId === sidebarActiveWorkspaceId ? selectedSessionId : null;
    const tab = route.replace(/^\/settings\/?/, "").replace(/^\/+|\/+$/g, "") || "general";
    const target = workspaceId ? workspaceSettingsRoute(workspaceId, tab) : route;
    writeActiveWorkspaceId(workspaceId || null);
    navigate(target, { state: { workspaceId, sessionId } });
  }, [navigate, selectedSessionId, sidebarActiveWorkspaceId]);

  const handleOpenExtensions = useCallback((path = "", workspaceId = sidebarActiveWorkspaceId) => {
    const sessionId = workspaceId === sidebarActiveWorkspaceId ? selectedSessionId : null;
    const extensionPath = path
      .replace(/^\/settings\/extensions\/?/, "")
      .replace(/^\/extensions\/?/, "")
      .replace(/^\/+|\/+$/g, "")
      .replace(/^mcp$/, "mcps");
    const target = workspaceId
      ? workspaceExtensionsRoute(workspaceId, extensionPath)
      : globalExtensionsRoute(extensionPath);
    writeActiveWorkspaceId(workspaceId || null);
    navigate(target, { state: { workspaceId, sessionId } });
  }, [navigate, selectedSessionId, sidebarActiveWorkspaceId]);

  const extensionsMainOpen = /^\/(?:workspace\/[^/]+\/)?extensions(?:\/|$)/.test(location.pathname);

  const surfaceProps = useMemo(() => {
    if (!client || !selectedWorkspaceId || !selectedSessionId || !engineBaseUrl || !token || !engineClient) {
      return null;
    }

    // Transient-safety: when the user switches workspaces the URL-driven
    // selectedSessionId may still point at a session from the old workspace
    // for one render tick. Only block rendering when we KNOW the session
    // belongs to a different workspace (i.e., it exists in another
    // workspace's list). A brand-new session that hasn't been refreshed
    // into any list yet must still render so "New task" feels instant.
    let sessionOwnedByOtherWorkspace = false;
    for (const [workspaceId, sessions] of Object.entries(sessionsByWorkspaceId)) {
      if (workspaceId === selectedWorkspaceId) continue;
      if ((sessions ?? []).some((session) => session?.id === selectedSessionId)) {
        sessionOwnedByOtherWorkspace = true;
        break;
      }
    }
    if (sessionOwnedByOtherWorkspace) {
      return null;
    }

    // Note: do NOT include `client`, `workspaceId`, `sessionId`,
    // `engineBaseUrl`, or `sofiaToken` here. SessionPage forwards those
    // explicitly to SessionSurface from the per-workspace endpoint resolved
    // by `resolveWorkspaceEndpoint`. If we leak them in here, the spread of
    // `surfaceProps` in SessionPage overrides those correct values with the
    // local server's, and remote workspaces silently end up calling the
    // local server with the local `rem_*` id.
    return {
      workspaceRoot: selectedWorkspaceRoot,
      developerMode: false,
      modelLabel,
      onModelClick: (sessionId?: string) => {
        setModelPickerSessionId(sessionId ?? null);
        modelPicker.setQuery("");
        modelPicker.setOpen(true);
      },
      providerCatalog,
      modelPickerOpen: modelPicker.compactOpen,
      modelUnavailable: selectedSessionModelUnavailable,
      modelUnavailableMessage,
      organizationModelsEmpty,
      selectedModel: local.prefs.defaultModel ?? { providerID: "", modelID: "" },
      sofiaModelsEntitled,
      sofiaModelsSyncing,
      onRefreshOrganizationModels: refreshOrganizationModelAccess,
      onModelPickerOpenChange: (open: boolean) => {
        modelPicker.setCompactOpen(open);
        if (open) {
          void refreshCloudProviderSync("model_picker_open");
        }
      },
      onModelChange: (model: ModelRef, variant?: string | null) => {
        local.setPrefs((previous) => ({
          ...previous,
          defaultModel: model,
          modelVariant: variant !== undefined
            ? variant
            : previous.defaultModel?.providerID === model.providerID && previous.defaultModel.modelID === model.modelID
              ? previous.modelVariant
              : null,
        }));
        modelPicker.setCompactOpen(false);
      },
      providerConnectedCount: hasUsableModel ? 1 : providerConnectedIds.length,
      onOpenSettingsSection: (section: ComposerSettingsSection) => {
        openComposerConfigure(section, {
          openLibrary: handleOpenExtensions,
          openSettings: handleOpenSettings,
        });
      },
      onSendDraft: async (draft: ComposerDraft, sessionId: string): Promise<CloudMcpSubmissionResult> => {
        const targetSessionId = sessionId.trim() || selectedSessionId;
        if (!targetSessionId) return { outcome: "cancelled", reason: "context_changed" };
        const text = (draft.resolvedText ?? draft.text).trim();
        if (!text && draft.attachments.length === 0) {
          return { outcome: "cancelled", reason: "context_changed" };
        }
        const sessionModelSelection = getSessionModelSelection(targetSessionId);
        const sendModel = sessionModelSelection?.model ?? local.prefs.defaultModel;
        const sendVariant = sessionModelSelection ? sessionModelSelection.variant : modelVariantValue;
        // Sofia sessions bypass the engine send pipeline entirely while
        // preserving the same per-session model selection as the composer.
        if (codexEngine.enabled && codexEngine.prompt && targetSessionId.startsWith("codex-")) {
          const selection = {
            model: sendModel?.modelID,
            providerId: sendModel?.providerID,
          };
          const parts = await draftToParts(draft, selectedWorkspaceRoot, targetSessionId, selectedWorkspaceEndpoint);
          const promptText = parts.map((part) => {
            if (part.type === "text") return part.text;
            if (part.type === "file") return `\nReferenced file: ${part.filename ?? "file"} (${part.url})\n`;
            return `Use the ${part.name} agent. `;
          }).join("") || text;
          // Render the user's message immediately; it is dropped once the
          // engine echoes it back as a `userMessage` item.
          useCodexSessionStore.getState().addPendingUserMessage(targetSessionId, text);
          try {
            const turnRunning = useCodexSessionStore.getState().sessions[targetSessionId]?.session.status === "running";
            if (turnRunning && codexEngine.steer) {
              const result = await codexEngine.steer(targetSessionId, promptText);
              if (result.outcome === "not_steerable" || result.outcome === "turn_mismatch") {
                useCodexSessionStore.getState().confirmPendingUserMessage(targetSessionId, text);
                useComposerStateStore.getState().appendQueuedDraft(targetSessionId, draft);
              } else if (result.outcome === "no_active_turn") {
                await codexEngine.prompt(targetSessionId, promptText, selection);
              }
            } else {
              await codexEngine.prompt(targetSessionId, promptText, selection);
            }
          } catch (error) {
            useCodexSessionStore.getState().confirmPendingUserMessage(targetSessionId, text);
            // Let the composer retain the draft. A rejected follow-up does not
            // stop the active turn and must never disappear silently.
            throw error;
          }
          return { outcome: "accepted" };
        }
        // Per-conversation model memory: a session that picked its own model
        // sends with it (and its variant) instead of the global default.
        if (!sessionModelSelection && selectedModelUnavailable) throw new Error("Selected model is unavailable. Choose another model before sending.");

        return submitWithCloudMcpReadiness({
          // Temporarily bypass the pre-send Cloud MCP gate: it blocks every
          // message, including tasks that do not use connected services.
          skipGate: true,
          send: async () => {
            await sendWithRevertRollback({
              revertMessageId: draft.revertMessageId,
              abort: () => abortSessionSafe(engineClient, targetSessionId, selectedWorkspaceRoot || undefined, {
                source: "session.edit_resend.before_revert",
                initiator: "user",
                reason: "abort active run before replacing a reverted message",
              }),
              revert: async (messageId) => {
                const reverted = await revertSession(engineClient, targetSessionId, messageId);
                applySessionRevert(selectedWorkspaceId, reverted);
              },
              prompt: async () => {
                captureAnalyticsEvent("task_message_sent", {
                  mode: draft.mode ?? "prompt",
                  is_command: Boolean(draft.command),
                  attachment_count: draft.attachments.length,
                  text_length: text.length,
                  workspace_type: selectedWorkspace?.workspaceType ?? "unknown",
                  provider_id: sendModel?.providerID ?? null,
                  model_id: sendModel?.modelID ?? null,
                });
                markTaskRunStart(targetSessionId);
                // Den org adoption signals (auth-gated inside; no-op when signed out).
                // This remains inside the post-readiness send closure so a blocked
                // Cloud submission cannot create a run or report that one started.
                const projectDimension = readWorkspaceProjectDimension(selectedWorkspaceId);
                const modelSelection = sessionModelSelection ? "manual" : "default";
                const telemetryDimensions = [
                  ...(projectDimension ? [{
                    type: "project",
                    label: projectDimension.label,
                  }] : []),
                  ...(sendModel ? [{
                    type: "model",
                    value: `${sendModel.providerID}/${sendModel.modelID}`,
                    label: `${sendModel.providerID}/${sendModel.modelID}`,
                  }] : []),
                  {
                    type: "model_selection",
                    value: modelSelection,
                    label: modelSelection,
                  },
                ];
                trackSessionActive(targetSessionId, telemetryDimensions);
                trackTaskStarted(targetSessionId, telemetryDimensions);

                if (draft.mode === "shell") {
                  await shellInSession(engineClient, targetSessionId, text);
                  return;
                }

                if (draft.command) {
                  const result = await engineClient.session.command({
                    sessionID: targetSessionId,
                    command: draft.command.name,
                    arguments: draft.command.arguments,
                  });
                  if (result.error) {
                    throw new Error(serializeSDKError(result.error));
                  }
                  return;
                }

                const parts = await draftToParts(draft, selectedWorkspaceRoot, targetSessionId, selectedWorkspaceEndpoint);
                const envSystemContext = await buildSofiaEnvSystemContext(client, {
                  cacheKey: targetSessionId,
                  runtimeKey: environmentRuntimeKey,
                });
                const result = await engineClient.session.promptAsync({
                  sessionID: targetSessionId,
                  parts,
                  model: sendModel ?? undefined,
                  agent: selectedAgent ?? undefined,
                  ...(sendVariant ? { variant: sendVariant } : {}),
                  ...(envSystemContext ? { system: envSystemContext } : {}),
                });
                if (result.error) {
                  throw new Error(serializeSDKError(result.error));
                }
                // Remember what this conversation used last so returning to it
                // (or splitting it beside another session) keeps its own model.
                if (sendModel) {
                  useSessionModelStore.getState().setModel(targetSessionId, sendModel, sendVariant ?? null);
                }
              },
              unrevert: async () => {
                try {
                  await unrevertSession(engineClient, targetSessionId);
                } finally {
                  applySessionUnrevert(selectedWorkspaceId, targetSessionId);
                }
              },
              onUnrevertError: (error) => console.warn("[edit-resend] rollback failed", error),
            });
          },
        });
      },
      cloudMcpSubmissionState,
      onOpenConnect: () => handleOpenExtensions(),
      onDraftChange: () => {
        // Draft persistence will be wired once the full React shell owns session state.
      },
      attachmentsEnabled: true,
      attachmentsDisabledReason: null,
      modelVariantLabel,
      modelVariant: modelVariantValue,
      modelBehaviorOptions,
      onModelVariantChange: (value: string | null) => {
        local.setPrefs((previous) => ({ ...previous, modelVariant: value }));
      },
      agentLabel: selectedAgent ? selectedAgent.charAt(0).toUpperCase() + selectedAgent.slice(1) : t("session.default_agent"),
      selectedAgent,
      listAgents,
      onSelectAgent: (agent: string | null) => setSelectedAgent(agent),
      listCommands: listSlashCommands,
      recentFiles: [],
      searchFiles: async (query: string) => {
        const trimmed = query.trim();
        const result = unwrap(
          await engineClient.find.files({
            query: trimmed,
            dirs: "true",
            limit: 50,
            directory: selectedWorkspaceRoot || undefined,
          }),
        );
        return result;
      },
      isRemoteWorkspace: selectedWorkspace?.workspaceType === "remote",
      isSandboxWorkspace: selectedWorkspace ? isSandboxWorkspace(selectedWorkspace) : false,
      onRevertToMessage: async (messageId: string, sessionId: string) => {
        const targetSessionId = sessionId.trim() || selectedSessionId;
        if (!targetSessionId) return false;
        try {
          // Abort any running generation first; Sofia rejects revert on busy sessions.
          await abortSessionSafe(engineClient, targetSessionId, selectedWorkspaceRoot || undefined, {
            source: "session.revert_to_message.before_revert",
            initiator: "user",
            reason: "abort active run before reverting transcript",
          });
          const reverted = await revertSession(engineClient, targetSessionId, messageId);
          // Stamp the revert cursor into the local caches so the transcript
          // rewinds immediately instead of waiting for a full reload.
          applySessionRevert(selectedWorkspaceId, reverted);
          return true;
        } catch (error) {
          console.warn("[revert] failed", error);
          toast.error(t("session.revert_failed"));
          return false;
        }
      },
      onRestoreRevertedSession: async (sessionId: string) => {
        const targetSessionId = sessionId.trim() || selectedSessionId;
        if (!targetSessionId) return false;
        try {
          await unrevertSession(engineClient, targetSessionId);
          applySessionUnrevert(selectedWorkspaceId, targetSessionId);
          return true;
        } catch (error) {
          console.warn("[unrevert] failed", error);
          toast.error(t("session.restore_failed"));
          return false;
        }
      },
      onForkAtMessage: (messageId: string | null, sessionId: string) => {
        void (async () => {
          const targetSessionId = sessionId.trim() || selectedSessionId;
          if (!targetSessionId) return;
          try {
            const forked = await forkSession(engineClient, targetSessionId, messageId ?? undefined);
            writeLastSessionFor(selectedWorkspaceId, forked.id);
            rememberPendingCreatedSession(selectedWorkspaceId, forked.id);
            setSessionsByWorkspaceId((current) => ({
              ...current,
              [selectedWorkspaceId]: [forked, ...(current[selectedWorkspaceId] ?? [])],
            }));
            navigateToWorkspaceSession(selectedWorkspaceId, forked.id);
            void refreshRouteState();
          } catch (error) {
            console.warn("[fork] failed", error);
            toast.error(t("session.branch_failed"));
          }
        })();
      },
      onChangeModel: (model: { providerID: string; modelID: string }) => {
        local.setPrefs((previous) => ({
          ...previous,
          defaultModel: model,
          modelVariant: previous.defaultModel?.providerID === model.providerID && previous.defaultModel.modelID === model.modelID
            ? previous.modelVariant
            : null,
        }));
      },
      environmentRuntimeKey,
      onApplyEnvironmentChanges: isDesktopRuntime() && selectedWorkspace?.workspaceType !== "remote"
        ? handleApplyEnvironmentChanges
        : undefined,
      approvalAccessory:
        codexEngine.client
          ? <ApprovalModeSelector client={codexEngine.client} />
          : undefined,
    };
  }, [
    client,
    modelPicker.compactOpen,
    handleOpenExtensions,
    handleOpenSettings,
    hasUsableModel,
    handleApplyEnvironmentChanges,
    environmentRuntimeKey,
    local,
    listAgents,
    listSlashCommands,
    modelBehaviorOptions,
    cloudMcpSubmissionState,
    modelLabel,
    modelUnavailableMessage,
    organizationModelsEmpty,
    modelVariantLabel,
    modelVariantValue,
    navigate,
    providerCatalog,
    sofiaModelsEntitled,
    sofiaModelsSyncing,
    refreshCloudProviderSync,
    refreshOrganizationModelAccess,
    engineBaseUrl,
    engineClient,
    providerConnectedIds,
    selectedAgent,
    selectedSessionId,
    selectedModelUnavailable,
    selectedWorkspace,
    selectedWorkspaceId,
    selectedWorkspaceRoot,
    sessionsByWorkspaceId,
    submitWithCloudMcpReadiness,
    token,
  ]);
  const cloudWorkspaceMainContentDecision = mapCloudWorkspaceMainContentDecision({
    status: cloudWorkspace.viewModel.variant,
    hasWorkspaces: Boolean(surfaceProps),
    gatewayMode: cloudWorkspace.gatewayMode && cloudWorkspace.visible,
  });
  const cloudWorkspaceReadyForRouteErrors =
    !cloudWorkspace.gatewayMode ||
    !cloudWorkspace.visible ||
    cloudWorkspaceStatusHasReadyContent(cloudWorkspace.viewModel.variant);
  const cloudWorkspaceMainContentTakeover = cloudWorkspaceMainContentDecision === "takeover" ? (
    <CloudWorkspaceBootTakeover decision={cloudWorkspaceMainContentDecision} />
  ) : null;
  const gatedRouteNotFoundMessage = cloudWorkspaceReadyForRouteErrors ? routeNotFoundMessage : null;

  // Workspace-scoped wiring for the empty-state hero's full composer. Unlike
  // `surfaceProps` this exists without a selected session, so the hero offers
  // the same skills/commands/agent/model controls before the session is
  // created. Model and agent choices land in the same route-level state the
  // session composer reads, so they carry into the created session.
  const newTaskComposerContext = useMemo<NewTaskComposerContext | null>(() => {
    return {
      client,
      workspaceId: selectedWorkspaceId || null,
      selectedModel: local.prefs.defaultModel ?? { providerID: "", modelID: "" },
      modelOptions: organizationAssignedModelOptions,
      modelUnavailable: selectedModelUnavailable,
      modelUnavailableMessage,
      organizationModelsEmpty,
      onRefreshOrganizationModels: refreshOrganizationModelAccess,
      modelPickerOpen: modelPicker.compactOpen,
      onModelPickerOpenChange: (open: boolean) => {
        modelPicker.setCompactOpen(open);
        if (open) {
          void sessionProviderAuthStore.refreshCloudOrgProviders({ force: true }).catch(() => undefined);
          void refreshCloudProviderSync("model_picker_open");
        }
      },
      onModelChange: (model: ModelRef, variant?: string | null) => {
        local.setPrefs((previous) => ({
          ...previous,
          defaultModel: model,
          modelVariant: variant !== undefined
            ? variant
            : previous.defaultModel?.providerID === model.providerID && previous.defaultModel.modelID === model.modelID
              ? previous.modelVariant
              : null,
        }));
        modelPicker.setCompactOpen(false);
      },
      sofiaModelsEntitled,
      sofiaModelsSyncing,
      modelVariantLabel,
      modelVariant: modelVariantValue,
      modelBehaviorOptions,
      onModelVariantChange: (value: string | null) => {
        local.setPrefs((previous) => ({ ...previous, modelVariant: value }));
      },
      agentLabel: selectedAgent ? selectedAgent.charAt(0).toUpperCase() + selectedAgent.slice(1) : t("session.default_agent"),
      selectedAgent,
      listAgents,
      onSelectAgent: (agent: string | null) => setSelectedAgent(agent),
      listCommands: listSlashCommands,
      searchFiles: async (query: string) => {
        const trimmed = query.trim();
        if (!engineClient) return [];
        const result = unwrap(
          await engineClient.find.files({
            query: trimmed,
            dirs: "true",
            limit: 50,
            directory: selectedWorkspaceRoot || undefined,
          }),
        );
        return result;
      },
      isRemoteWorkspace: selectedWorkspace?.workspaceType === "remote",
      isSandboxWorkspace: selectedWorkspace ? isSandboxWorkspace(selectedWorkspace) : false,
      onOpenSettingsSection: (section: ComposerSettingsSection) => {
        openComposerConfigure(section, {
          openLibrary: handleOpenExtensions,
          openSettings: handleOpenSettings,
        });
      },
    };
  }, [
    client,
    handleOpenExtensions,
    handleOpenSettings,
    listAgents,
    listSlashCommands,
    local,
    modelUnavailableMessage,
    modelBehaviorOptions,
    modelPicker,
    modelVariantLabel,
    modelVariantValue,
    engineClient,
    sofiaModelsEntitled,
    sofiaModelsSyncing,
    organizationAssignedModelOptions,
    organizationModelsEmpty,
    refreshCloudProviderSync,
    refreshOrganizationModelAccess,
    selectedAgent,
    selectedModelUnavailable,
    selectedWorkspace,
    selectedWorkspaceId,
    selectedWorkspaceRoot,
    sessionProviderAuthStore,
    setSelectedAgent,
  ]);

  const handleOpenCreateWorkspace = useCallback(() => {
    if (!canCreateWorkspaces()) return;
    // Respect the org-level `allowMultipleWorkspaces` restriction (dev
    // #1505). If the checker returns true, the admin has disabled
    // adding further workspaces; surface a friendly notice instead of
    // opening the modal.
    if (
      workspaces.length > 0 &&
      checkDesktopRestriction({ restriction: "allowMultipleWorkspaces" })
    ) {
      restrictionNotice.show({
        title: "Additional workspaces are restricted",
        message:
          "Your organization administrator has restricted access to adding additional workspaces.",
      });
      return;
    }
    setCreateWorkspaceRemoteError(null);
    setCreateWorkspaceOpen(true);
  }, [checkDesktopRestriction, restrictionNotice, workspaces.length]);

  const handleOpenRenameWorkspace = useCallback((workspaceId: string) => {
    const workspace = workspaces.find((item) => item.id === workspaceId);
    if (!workspace) return;
    setRenameWorkspaceId(workspaceId);
    setRenameWorkspaceTitle(
      workspace.displayName?.trim() ||
        workspace.name?.trim() ||
        workspace.path?.trim() ||
        "",
    );
  }, [workspaces]);

  const handleSaveRenameWorkspace = useCallback(async () => {
    if (!renameWorkspaceId) return;
    const trimmed = renameWorkspaceTitle.trim();
    if (!trimmed) return;
    setRenameWorkspaceBusy(true);
    try {
      if (!client) {
        toast.error("Sofia App server is unavailable. Reconnect the server before renaming workspaces.");
        return;
      }
      await client.updateWorkspaceDisplayName(renameWorkspaceId, trimmed);
      setRenameWorkspaceId(null);
      setRenameWorkspaceTitle("");
      await refreshRouteState();
    } catch (error) {
      toast.error("Workspace rename failed", {
        description: describeRouteError(error),
      });
    } finally {
      setRenameWorkspaceBusy(false);
    }
  }, [client, refreshRouteState, renameWorkspaceId, renameWorkspaceTitle]);

  const handleRevealWorkspace = useCallback(async (workspaceId: string) => {
    const workspace = workspaces.find((item) => item.id === workspaceId);
    const path = workspace?.path?.trim();
    if (!path || !isDesktopRuntime()) return;
    try {
      await revealDesktopItemInDir(path);
    } catch {
      // ignore
    }
  }, [workspaces]);

  const handleShareWorkspace = useCallback((workspaceId: string) => {
    shareWorkspaceState.openShareWorkspace(workspaceId);
  }, [shareWorkspaceState]);

  const handleSaveShareRemoteAccess = useCallback(
    async (enabled: boolean) => {
      if (!isDesktopRuntime()) return;
      await remoteAccessRestart.save(enabled);
    },
    [remoteAccessRestart],
  );

  const handleExportWorkspaceConfig = useCallback(
    async (workspaceId: string) => {
      const workspace = workspaces.find((item) => item.id === workspaceId) ?? null;
      if (!workspace) return;
      const endpoint = endpointForWorkspace(workspace);
      if (endpoint) {
        const payload = await endpoint.client.exportWorkspace(endpoint.workspaceId);
        downloadWorkspaceJson(workspaceExportFilename(workspace), payload);
        return;
      }
      throw new Error("Sofia App server is unavailable. Reconnect the server before exporting workspace config.");
    },
    [endpointForWorkspace, workspaces],
  );

  const handleForgetWorkspace = useCallback(
    async (workspaceId: string) => {
      if (typeof window !== "undefined") {
        const message =
          t("workspace_list.remove_confirm") ||
          "Remove this workspace from the sidebar?";
        if (!window.confirm(message)) return;
      }
      // Remove from both stores so the next refresh can't resurrect the row
      // from whichever list wins the merge.
      if (client) {
        await client.deleteWorkspace(workspaceId).catch(() => undefined);
      }
      if (isDesktopRuntime()) {
        await workspaceForget(workspaceId).catch(() => undefined);
      }
      if (selectedWorkspaceId === workspaceId) {
        setLegacySelectedWorkspaceId("");
        writeActiveWorkspaceId(null);
        navigate(legacySessionRoute());
      }
      forgetWorkspaceMemory(workspaceId);
      sessionManagementStore.getState().forgetWorkspace(workspaceId);
      await refreshRouteState();
    },
    [client, navigate, refreshRouteState, selectedWorkspaceId],
  );


  const applyLastUsedModelToSession = useCallback((sessionId: string) => {
    const previous = selectedSessionId ? getSessionModelSelection(selectedSessionId) : null;
    const model = previous?.model ?? local.prefs.defaultModel;
    if (!model?.providerID || !model.modelID) return;
    const variant = previous ? previous.variant : (local.prefs.modelVariant ?? null);
    useSessionModelStore.getState().setModel(sessionId, model, variant);
    local.setPrefs((current) => {
      if (
        current.defaultModel?.providerID === model.providerID
        && current.defaultModel.modelID === model.modelID
        && (current.modelVariant ?? null) === variant
      ) {
        return current;
      }
      return { ...current, defaultModel: model, modelVariant: variant };
    });
  }, [local, selectedSessionId]);

  const handleCreateTaskInWorkspace = useCallback(async (workspaceId: string): Promise<string | null> => {
    const workspace = workspaces.find((item) => item.id === workspaceId);
    if (
      !workspace ||
      loading ||
      (!codexEngine.enabled && retryingWorkspaceIds.includes(workspaceId))
    ) {
      return null;
    }
    // Sofia engine: create a codex session (the surface sends the first prompt).
    if (codexEngine.enabled && codexEngine.createSession) {
      try {
        const preferredModel = local.prefs.defaultModel;
        const selectedProviderIsConfigured = Boolean(
          preferredModel && codexEngine.config?.providers.some((provider) => provider.providerId === preferredModel.providerID),
        );
        const targetEndpoint = endpointForWorkspace(workspace);
        if (!targetEndpoint) throw new Error("The selected workspace is unavailable");
        const targetClient = createCodexSessionClient({
          baseUrl: targetEndpoint.baseUrl, token: targetEndpoint.token,
          hostToken: targetEndpoint.isRemote ? workspace.sofiaHostToken ?? undefined : sofiaServerHostInfoState?.hostToken ?? undefined,
          workspaceId: targetEndpoint.workspaceId,
        });
        const result = await targetClient.createSession({
          title: "New Sofia task",
          cwd: workspace.path?.trim() || undefined,
          model: selectedProviderIsConfigured ? preferredModel?.modelID : codexEngine.config?.model ?? undefined,
          providerId: selectedProviderIsConfigured ? preferredModel?.providerID : codexEngine.config?.defaultProviderId ?? undefined,
        });
        const session = { ...result.session, workspaceId };
        useCodexSessionStore.getState().upsertSession(session);
        setLegacySelectedWorkspaceId(workspaceId);
        writeActiveWorkspaceId(workspaceId || null);
        writeLastSessionFor(workspaceId, session.id);
        rememberPendingCreatedSession(workspaceId, session.id);
        navigateToWorkspaceSession(workspaceId, session.id);
        focusPromptSoon();
        return session.id;
      } catch (error) {
        toast.error("Unable to create Sofia task", { description: describeRouteError(error) });
        return null;
      }
    }
    const endpoint = endpointForWorkspace(workspace);
    if (!endpoint || !endpoint.token) {
      return null;
    }
    const workspaceClient = createClient(
      endpoint.engineBaseUrl,
      workspace.path?.trim() || undefined,
      { token: endpoint.token, mode: "sofia" },
    );
    try {
      setErrorsByWorkspaceId((current) => ({ ...current, [workspaceId]: null }));
      setRouteError(null);
      const session = unwrap(
        await workspaceClient.session.create({ directory: workspace.path?.trim() || undefined }),
      );
      if (workspaceId === selectedWorkspaceId) {
        void refreshCloudProviderSync("new_chat");
      }
      captureAnalyticsEvent("task_created", {
        source: "new_task",
        workspace_type: workspace.workspaceType ?? "unknown",
      });
      toast.dismiss(taskCreateUnavailableToastId(workspaceId));
      toast.dismiss();
      setLegacySelectedWorkspaceId(workspaceId);
      writeActiveWorkspaceId(workspaceId || null);
      writeLastSessionFor(workspaceId, session.id);
      rememberPendingCreatedSession(workspaceId, session.id);
      applyLastUsedModelToSession(session.id);
      setSessionsByWorkspaceId((current) => {
        const next = {
          ...current,
          [workspaceId]: [session, ...(current[workspaceId] ?? [])],
        };
        sessionsByWorkspaceIdRef.current = next;
        return next;
      });
      navigateToWorkspaceSession(workspaceId, session.id);
      focusPromptSoon();
      void refreshRouteState();
      return session.id;
    } catch (error) {
      const message = describeTaskCreateError(error);
      setRouteError(message);
      setErrorsByWorkspaceId((current) => ({ ...current, [workspaceId]: message }));
      toast.error("Engine unavailable", {
        id: taskCreateUnavailableToastId(workspaceId),
        description: message,
        action: {
          label: "Retry",
          onClick: () => void handleCreateTaskInWorkspace(workspaceId),
        },
        duration: Infinity,
      });
      if (isTransientStartupError(message)) {
        setRetryingWorkspaceIds((current) => Array.from(new Set([...current, workspaceId])));
        if (startupRetryTimerRef.current === null) {
          startupRetryTimerRef.current = window.setTimeout(() => {
            startupRetryTimerRef.current = null;
            void refreshRouteState({ supersede: true });
          }, 1_000);
        }
      }
      return null;
    }
  }, [applyLastUsedModelToSession, codexEngine, endpointForWorkspace, loading, navigateToWorkspaceSession, refreshCloudProviderSync, refreshRouteState, rememberPendingCreatedSession, retryingWorkspaceIds, selectedWorkspaceId, workspaces]);

  // Latest session-list state for prev/next session tab navigation. The
  // `options` field is updated by `onSessionTabsChange` from SessionPage so we
  // only cycle through tabs the user actually opened (not artifact sessions).
  // The remaining fields are refreshed during render.
  const sessionTabNavRef = useRef<{
    options: OpenSessionTab[];
    workspaceId: string;
    sessionId: string | null;
    navigate: (workspaceId: string, sessionId?: string | null) => void;
  }>({ options: [], workspaceId: "", sessionId: null, navigate: () => {} });

  const goToSessionTabByOffset = useCallback((offset: number) => {
    const { options, workspaceId, sessionId, navigate } = sessionTabNavRef.current;
    const scoped = options.filter((option) => option.workspaceId === workspaceId);
    if (scoped.length === 0) return;
    const currentIndex = sessionId
      ? scoped.findIndex((option) => option.sessionId === sessionId)
      : -1;
    const nextIndex = currentIndex === -1
      ? offset > 0 ? 0 : scoped.length - 1
      : (currentIndex + offset + scoped.length) % scoped.length;
    const target = scoped[nextIndex];
    if (!target || target.sessionId === sessionId) return;
    navigate(target.workspaceId, target.sessionId);
  }, []);

  const goToNextSessionTab = useCallback(() => goToSessionTabByOffset(1), [goToSessionTabByOffset]);
  const goToPrevSessionTab = useCallback(() => goToSessionTabByOffset(-1), [goToSessionTabByOffset]);

  const {
    commandPaletteOpen,
    setCommandPaletteOpen,
    sessionSearchOpen,
    setSessionSearchOpen,
    terminalOpen,
    setTerminalOpen,
    sessionNumberShortcuts,
  } = useShellShortcuts({
    canCreateTask,
    workspaceId: selectedWorkspaceId,
    onCreateTask: (workspaceId: string) => void handleCreateTaskInWorkspace(workspaceId),
    onNextSessionTab: goToNextSessionTab,
    onPrevSessionTab: goToPrevSessionTab,
  });
  useReactRenderWatchdog("SessionRoute", {
    selectedSessionId,
    selectedWorkspaceId,
    loading,
    workspaceCount: workspaces.length,
    sessionGroupCount: Object.keys(sessionsByWorkspaceId).length,
    commandPaletteOpen,
    modelPickerOpen: modelPicker.open,
  });

  const navigateToSessionForControl = useCallback((sessionId: string) => {
    const owner = Object.entries(sessionsByWorkspaceId).find(([, sessions]) =>
      (sessions ?? []).some((session) => session?.id === sessionId),
    )?.[0];
    navigateToWorkspaceSession(owner || selectedWorkspaceId, sessionId);
  }, [navigateToWorkspaceSession, selectedWorkspaceId, sessionsByWorkspaceId]);

  const navigateToSessionRootForControl = useCallback(() => {
    navigateToWorkspaceSession(selectedWorkspaceId);
  }, [navigateToWorkspaceSession, selectedWorkspaceId]);

  const openModelPickerForControl = useCallback(() => {
    modelPicker.setOpen(true);
  }, []);

  useSessionControlActions({
    workspaces,
    sessionsByWorkspaceId,
    selectedWorkspaceId,
    selectedWorkspaceRoot,
    selectedSessionId,
    canCreateTask,
    sofiaClient: client,
    engineClient,
    navigateToSession: navigateToSessionForControl,
    navigateToSessionRoot: navigateToSessionRootForControl,
    createTaskInWorkspace: handleCreateTaskInWorkspace,
    openModelPicker: openModelPickerForControl,
    refreshRouteState,
  });

  const seedUnavailableModelControlAction = useMemo<SofiaControlAction | null>(() => {
    if (!import.meta.env.DEV) return null;
    return {
      id: "eval.model_not_available.seed",
      label: "Seed an unavailable selected model",
      description: "Dev-only eval hook that selects a missing model and returns an available model to recover with.",
      sideEffect: "mutation",
      disabled: !engineClient,
      execute: async () => {
        if (!engineClient) return { ok: false, error: "Sofia engine is not connected." };

        const providerList = await ensureProviderListQuery(getReactQueryClient(), {
          client: engineClient,
          baseUrl: engineBaseUrl,
          directory: selectedWorkspaceRoot || undefined,
          force: true,
        });
        const filteredProviderList = filterProviderList(providerList, disabledProviderIds);
        const availableProvider = getConnectedProviderItems(filteredProviderList)
          .filter((provider) => !isDesktopProviderBlocked({
            providerId: provider.id,
            checkRestriction: checkDesktopRestriction,
          }))
          .find((provider) => Object.keys(provider.models ?? {}).length > 0);
        const availableModelId = availableProvider ? Object.keys(availableProvider.models ?? {})[0] : undefined;
        const availableModel = availableProvider && availableModelId
          ? availableProvider.models[availableModelId]
          : undefined;

        if (!availableProvider || !availableModelId || !availableModel) {
          return { ok: false, error: "No available connected model found for eval recovery." };
        }

        const unavailableModel = nextEvalUnavailableModel(local.prefs.defaultModel);
        modelPicker.setQuery("");
        modelPicker.setRecentProviderIds(new Set());
        local.setPrefs((previous) => ({
          ...previous,
          defaultModel: unavailableModel,
          modelVariant: null,
        }));

        return {
          unavailableModel,
          availableModel: {
            providerID: availableProvider.id,
            providerName: availableProvider.name || availableProvider.id,
            modelID: availableModelId,
            title: availableModel.name || availableModelId,
          },
          sessionId: selectedSessionId,
          workspaceId: selectedWorkspaceId,
        };
      },
    };
  }, [checkDesktopRestriction, disabledProviderIds, local, modelPicker.setQuery, modelPicker.setRecentProviderIds, engineBaseUrl, engineClient, selectedSessionId, selectedWorkspaceId, selectedWorkspaceRoot]);
  useControlAction(seedUnavailableModelControlAction);

  const seedActiveSessionSidebarControlAction = useMemo<SofiaControlAction | null>(() => {
    if (!import.meta.env.DEV) return null;
    return {
      id: "eval.session_sidebar.seed_active",
      label: "Show the selected session as active",
      description: "Dev-only eval hook that displays the selected session activity spinner.",
      sideEffect: "mutation",
      disabled: !selectedWorkspaceId || !selectedSessionId,
      execute: () => {
        if (!selectedWorkspaceId || !selectedSessionId) {
          return { ok: false, error: "No session is selected." };
        }
        useSessionActivityStore.getState().setRunStatus(selectedWorkspaceId, selectedSessionId, "running");
        return { workspaceId: selectedWorkspaceId, sessionId: selectedSessionId };
      },
    };
  }, [selectedSessionId, selectedWorkspaceId]);
  useControlAction(seedActiveSessionSidebarControlAction);

  const commandPaletteControlAction = useMemo<SofiaControlAction>(() => ({
    id: "command_palette.open",
    label: "Open the command palette",
    description: "Open the in-app command palette so the next choice is visible.",
    effects: { data: "none", ui: "dialog", external: false },
    sideEffect: "none",
    execute: () => setCommandPaletteOpen(true),
  }), []);
  useControlAction(commandPaletteControlAction);

  const addProviderControlAction = useMemo<SofiaControlAction>(() => ({
    id: "settings.provider.add",
    label: "Add a model provider",
    description: "Open the provider connection modal, optionally pre-filtered to a specific provider.",
    sideEffect: "mutation",
    requiresArgs: false,
    args: [
      { name: "providerId", type: "string" as const, required: false, description: "Provider id to pre-select, e.g. 'anthropic', 'openai', 'google'." },
    ],
    execute: async (rawArgs: unknown) => {
      const providerId = typeof rawArgs === "object" && rawArgs !== null
        ? (rawArgs as Record<string, unknown>).providerId
        : undefined;
      const preferred = typeof providerId === "string" ? providerId.trim() : undefined;
      if (sessionProviderAuthStore.isProviderAddRestricted(preferred)) {
        return { ok: false, error: t("providers.custom_providers_disabled") };
      }
      await sessionProviderAuthStore.openProviderAuthModal(
        preferred ? { preferredProviderId: preferred } : undefined,
      );
      return { ok: true, opened: "provider_auth_modal", preferredProviderId: preferred ?? null };
    },
  }), [sessionProviderAuthStore]);
  useControlAction(addProviderControlAction);

  const handleOpenProviderAuth = useCallback(() => {
    if (sessionProviderAuthStore.isProviderAddRestricted()) {
      restrictionNotice.show({
        title: t("restrictions.add_custom_providers_disabled_title"),
        message: t("restrictions.add_custom_providers_disabled_message"),
      });
      return;
    }

    // Pre-workspace (chat-first) there is no engine client yet, so the
    // modal cannot load auth methods — fall back to the AI Providers page.
    void sessionProviderAuthStore.openProviderAuthModal({ returnFocusTarget: "composer" }).catch(() => {
      handleOpenSettings("/settings/ai");
    });
  }, [handleOpenSettings, restrictionNotice, sessionProviderAuthStore]);

  // "Connect more providers" in the compact model picker (and anything else
  // outside this route's prop tree) requests the provider auth modal here.
  useEffect(() => {
    const handler = () => handleOpenProviderAuth();
    window.addEventListener(openProviderAuthEvent, handler);
    return () => window.removeEventListener(openProviderAuthEvent, handler);
  }, [handleOpenProviderAuth]);

  const paletteSessionOptions = useMemo(
    () => buildCommandPaletteSessions(workspaces, sessionsByWorkspaceId, selectedWorkspaceId),
    [sessionsByWorkspaceId, selectedWorkspaceId, workspaces],
  );

  // Refresh the non-tab fields of the nav ref during render. The `options`
  // field is maintained by the `onSessionTabsChange` callback from SessionPage.
  sessionTabNavRef.current = {
    options: sessionTabNavRef.current.options,
    workspaceId: selectedWorkspaceId,
    sessionId: selectedSessionId,
    navigate: navigateToWorkspaceSession,
  };

  const paletteSessionGroups = useMemo<SessionGroupOption[]>(
    () => selectedWorkspaceGroupState?.groups ?? [],
    [selectedWorkspaceGroupState?.groups],
  );

  const currentSessionForGroupMove = useMemo(() => {
    if (!selectedWorkspaceId || !selectedSessionId) return null;
    return paletteSessionOptions.find(
      (session) => session.workspaceId === selectedWorkspaceId && session.sessionId === selectedSessionId,
    ) ?? null;
  }, [paletteSessionOptions, selectedSessionId, selectedWorkspaceId]);

  const currentSessionGroupId = selectedSessionId
    ? selectedWorkspaceGroupState?.assignments[selectedSessionId] ?? null
    : null;

  const handleMoveCurrentSessionToGroup = useCallback((groupId: string) => {
    if (!selectedWorkspaceId || !selectedSessionId) return;
    assignSessionToGroup(selectedWorkspaceId, selectedSessionId, groupId);
  }, [assignSessionToGroup, selectedSessionId, selectedWorkspaceId]);

  const sessionSearchFetcher = useMemo<SessionMessageFetcher | null>(() => {
    if (!client) return null;
    // Cap the transcript fetch to keep multi-workspace scans fast; matches in
    // anything older than the most recent 400 messages are traded away for
    // responsiveness.
    return async (workspaceId: string, sessionId: string) =>
      (await client.getSessionMessages(workspaceId, sessionId, { limit: 400 })).items;
  }, [client]);

  const sessionSearchPaletteItem = useMemo<PaletteItem>(() => ({
    id: "session-search.open",
    title: "Search session messages",
    detail: "Deep search every session, including message content",
    meta: "Cmd/Ctrl+Shift+F",
    searchText: "search find sessions messages history transcript content",
    action: () => {
      setCommandPaletteOpen(false);
      setSessionSearchOpen(true);
    },
  }), []);

  const sessionFindPaletteItem = useMemo<PaletteItem | null>(() => {
    if (!selectedSessionId) return null;
    return {
      id: "session-find.open",
      title: "Find in conversation",
      detail: "Search within the current conversation",
      meta: "Cmd/Ctrl+F",
      searchText: "find search current conversation session messages transcript",
      action: () => {
        setCommandPaletteOpen(false);
        useSessionFindStore.getState().openFind({ sessionId: selectedSessionId });
      },
    };
  }, [selectedSessionId]);

  const terminalPaletteItems = useMemo<PaletteItem[]>(() => platform.capabilities.terminal ? [
    {
      id: "terminal.toggle",
      title: terminalOpen ? "Hide terminal" : "Show terminal",
      detail: "Toggle the integrated terminal panel for this workspace",
      meta: "Cmd/Ctrl+J",
      searchText: "terminal shell command line console show hide toggle",
      action: () => {
        setCommandPaletteOpen(false);
        setTerminalOpen((value) => !value);
      },
    },
  ] : [], [platform.capabilities.terminal, terminalOpen]);

  const developerModePaletteItem = useMemo<PaletteItem>(() => ({
    id: "developer-mode.toggle",
    title: developerMode ? t("settings.disable_developer_mode") : t("settings.enable_developer_mode"),
    detail: t("settings.developer_mode_desc"),
    meta: developerMode ? "On" : "Off",
    searchText: "developer dev mode debug diagnostics toggle enable disable",
    action: () => {
      setCommandPaletteOpen(false);
      setDeveloperMode((current) => {
        const next = !current;
        try { window.localStorage.setItem("sofia.developerMode", next ? "1" : "0"); } catch {}
        return next;
      });
    },
  }), [developerMode]);

  const buildCommandDiagnosticsBundle = useCallback(() => buildDiagnosticsBundleJson({
    anyActiveRuns: activeReloadBlockingSessions.length > 0,
    canReloadWorkspace: reloadCoordinator.canReloadWorkspaceEngine,
    clientConnected: canCreateTask,
    developerMode,
    hostInfo: sofiaServerHostInfoState,
    sofiaServerStatus: client ? "connected" : "disconnected",
    sofiaServerUrl: baseUrl,
    runtimeWorkspaceId: selectedWorkspaceEndpoint?.workspaceId ?? null,
  }), [
    activeReloadBlockingSessions.length,
    baseUrl,
    canCreateTask,
    client,
    developerMode,
    sofiaServerHostInfoState,
    reloadCoordinator.canReloadWorkspaceEngine,
    selectedWorkspaceEndpoint?.workspaceId,
  ]);

  const diagnosticsCopyPaletteItem = useMemo<PaletteItem>(() => ({
    id: "diagnostics.copy",
    title: t("session.cmd_diagnostics_copy_title"),
    detail: t("session.cmd_diagnostics_copy_detail"),
    searchText: "logs share diagnostics debug support bundle troubleshoot copy report issue",
    action: async () => {
      setCommandPaletteOpen(false);
      try {
        const json = await buildCommandDiagnosticsBundle();
        await navigator.clipboard.writeText(json);
        toast.success(t("session.diagnostics_copied"));
      } catch (error) {
        toast.error(t("session.diagnostics_failed"), { description: describeRouteError(error) });
      }
    },
  }), [buildCommandDiagnosticsBundle]);

  const diagnosticsExportPaletteItem = useMemo<PaletteItem>(() => ({
    id: "diagnostics.export",
    title: t("session.cmd_diagnostics_export_title"),
    detail: t("session.cmd_diagnostics_export_detail"),
    searchText: "logs export diagnostics debug support bundle save file json download",
    action: async () => {
      setCommandPaletteOpen(false);
      try {
        const json = await buildCommandDiagnosticsBundle();
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        downloadTextAsFile(`sofia-diagnostics-${timestamp}.json`, json, "application/json");
        toast.success(t("session.diagnostics_exported"));
      } catch (error) {
        toast.error(t("session.diagnostics_failed"), { description: describeRouteError(error) });
      }
    },
  }), [buildCommandDiagnosticsBundle]);

  const nextSessionTabPaletteItem = useMemo<PaletteItem>(() => ({
    id: "session-tab.next",
    title: "Next session tab",
    detail: "Switch to the next session in this workspace",
    meta: "Cmd/Ctrl+T",
    searchText: "next session tab switch forward",
    action: () => {
      setCommandPaletteOpen(false);
      goToNextSessionTab();
    },
  }), [goToNextSessionTab]);

  const prevSessionTabPaletteItem = useMemo<PaletteItem>(() => ({
    id: "session-tab.previous",
    title: "Previous session tab",
    detail: "Switch to the previous session in this workspace",
    meta: "Cmd/Ctrl+Shift+T",
    searchText: "previous session tab switch back",
    action: () => {
      setCommandPaletteOpen(false);
      goToPrevSessionTab();
    },
  }), [goToPrevSessionTab]);

  const reloadConfigPaletteItem = useMemo<PaletteItem>(() => ({
    id: "reload-engine-config",
    title: t("session.cmd_reload_config_title"),
    detail: t("session.cmd_reload_config_detail"),
    meta: reloadCoordinator.canReloadWorkspaceEngine
      ? t("config.reload_engine")
      : t("system.reload_unavailable"),
    searchText: "reload engine config providers models mcp jsonc refresh re-read engine restart",
    action: () => {
      setCommandPaletteOpen(false);
      if (!reloadCoordinator.canReloadWorkspaceEngine) return;
      void reloadCoordinator.reloadWorkspaceEngine();
    },
  }), [reloadCoordinator.canReloadWorkspaceEngine, reloadCoordinator.reloadWorkspaceEngine]);

  const handleReorderWorkspaces = useCallback((workspaceIds: string[]) => {
    const activeWorkspaceIds = new Set(workspacesRef.current.map((workspace) => workspace.id));
    const nextOrderIds: string[] = [];
    const nextOrderIdSet = new Set<string>();

    for (const id of workspaceIds) {
      if (!activeWorkspaceIds.has(id) || nextOrderIdSet.has(id)) continue;
      nextOrderIds.push(id);
      nextOrderIdSet.add(id);
    }

    for (const workspace of workspacesRef.current) {
      if (nextOrderIdSet.has(workspace.id)) continue;
      nextOrderIds.push(workspace.id);
      nextOrderIdSet.add(workspace.id);
    }

    workspaceOrderIdsRef.current = nextOrderIds;
    setWorkspaceOrderIds(nextOrderIds);
    writeWorkspaceOrderIds(nextOrderIds);
    setWorkspaces((current) => orderRouteWorkspaces(current, nextOrderIds));
  }, []);

  const handleArchiveSession = useCallback(
    async (sessionId: string, archived: boolean) => {
      if (codexEngine.enabled && sessionId.startsWith("codex-")) {
        if (!codexEngine.archiveSession) throw new Error("Sofia engine is unavailable");
        await codexEngine.archiveSession(sessionId, archived);
        if (archived) {
          if (selectedSessionId === sessionId) {
            navigateToWorkspaceSession(selectedWorkspaceId);
          }
        }
        return;
      }
      if (!engineClient) return;
      try {
        await setSessionArchived(
          engineClient,
          sessionId,
          archived,
          selectedWorkspaceRoot || undefined,
        );
        await refreshRouteState();
      } catch (error) {
        console.error("[session-route] archive session failed", error);
        toast.error(
          archived
            ? t("session_management.archive_failed")
            : t("session_management.unarchive_failed"),
          { description: describeRouteError(error) },
        );
      }
    },
    [codexEngine.enabled, navigateToWorkspaceSession, engineClient, refreshRouteState, selectedSessionId, selectedWorkspaceId, selectedWorkspaceRoot],
  );

  const handleCreateWorkspace = useCallback(async (
    preset: WorkspacePreset,
    folder: string | null,
    options?: CreateWorkspaceOptions,
  ) => {
    if (!folder) return;
    const projectLabel = options?.projectLabel?.trim() ?? "";
    setCreateWorkspaceBusy(true);
    setCreateWorkspaceError(null);
    try {
      const workspaceName = folderNameFromPath(folder);
      let list: WorkspaceList | null = null;
      let createdOnServer = false;
      if (client) {
        list = await client
          .createLocalWorkspace({ folderPath: folder, name: workspaceName, preset })
          .then((serverList) => {
            createdOnServer = true;
            return serverList;
          })
          .catch(() => null);
      }
      if (!list) {
        throw new Error("Sofia App server is unavailable. Start or reconnect the server before creating a workspace.");
      }
      const createdId = resolveWorkspaceListSelectedId(list) || list.workspaces[list.workspaces.length - 1]?.id || "";
      let targetWorkspaceId = createdId;
      let targetWorkspace = list.workspaces.find((workspace: WorkspaceInfo) => workspace.id === createdId) ?? null;
      if (createdId) {
        await workspaceSetSelected(createdId).catch(() => undefined);
        await workspaceSetRuntimeActive(createdId).catch(() => undefined);
      }
      // First workspace on a fresh install: the Sofia App server was started
      // engine-less (it only spawns Sofia at boot when a workspace already
      // exists), so sessions would hang forever. This boots the engine when
      // it isn't running, same as the old /welcome flow did.
      let sessionBaseUrl = baseUrl;
      let sessionToken = token;
      if (targetWorkspace && isDesktopRuntime()) {
        await ensureDesktopLocalSofiaConnection({
          route: "session",
          workspace: targetWorkspace,
          allWorkspaces: list.workspaces,
        }).catch(() => undefined);
        // The engine boot can restart the server with fresh tokens; re-resolve
        // so the first-session creation below doesn't use stale credentials.
        const fresh = await resolveSofiaConnection().catch(() => null);
        if (fresh?.normalizedBaseUrl && fresh.resolvedToken) {
          sessionBaseUrl = fresh.normalizedBaseUrl;
          sessionToken = fresh.resolvedToken;
        }
      }
      setCreateWorkspaceOpen(false);
      // Mark onboarding complete so the /welcome redirect never fires again.
      local.setPrefs((prev) => ({ ...prev, hasCompletedOnboarding: true }));
      await refreshRouteState();
      if (targetWorkspaceId) {
        const workspacePath = targetWorkspace?.path?.trim() || folder;
        const firstTaskPrompt = options?.firstTaskPrompt?.trim() ?? "";
        const firstTaskAttachments = options?.firstTaskAttachments ?? [];
        // A workspace registry mutation must not eagerly instantiate an
        // Sofia directory. Chat-first creation still needs a session for
        // its supplied prompt; ordinary creation lands on the New task state.
        const session = createdOnServer && sessionBaseUrl && sessionToken && (firstTaskPrompt || firstTaskAttachments.length > 0)
          ? await createClient(
              `${(buildSofiaWorkspaceBaseUrl(sessionBaseUrl, targetWorkspaceId) ?? sessionBaseUrl).replace(/\/+$/, "")}/engine`,
              workspacePath || undefined,
              { token: sessionToken, mode: "sofia" },
            ).session.create({ directory: workspacePath || undefined })
              .then((result) => unwrap(result))
              .catch(() => null)
          : null;
        setLegacySelectedWorkspaceId(targetWorkspaceId);
        writeActiveWorkspaceId(targetWorkspaceId);
        if (projectLabel) {
          writeWorkspaceProjectDimension(targetWorkspaceId, {
            label: projectLabel,
          });
        }
        captureAnalyticsEvent("workspace_created", { workspace_type: "local" });
        if (session?.id) {
          captureAnalyticsEvent("task_created", { source: "workspace_created", workspace_type: "local" });
          if (firstTaskPrompt) {
            // Attachment chips only survive in-memory (File objects), so the
            // persisted fallback draft drops their tokens.
            saveSessionDraft(targetWorkspaceId, session.id, { text: firstTaskPrompt.replace(/\[attachment [^\]]+\]/g, "").trim(), mode: "prompt" });
            // The composer reads its draft from the composer state store, not
            // the persisted draft store — seed both so the prompt shows up.
            useComposerStateStore.getState().setDraft(session.id, firstTaskPrompt);
            if (firstTaskAttachments.length) {
              useComposerStateStore.getState().setAttachments(session.id, firstTaskAttachments);
            }
            // One-step run: the session surface sends the seeded draft itself.
            markComposerAutoSend(session.id);
          }
          writeLastSessionFor(targetWorkspaceId, session.id);
          rememberPendingCreatedSession(targetWorkspaceId, session.id);
          setSessionsByWorkspaceId((current) => {
            const next = {
              ...current,
              [targetWorkspaceId]: [session, ...(current[targetWorkspaceId] ?? [])],
            };
            sessionsByWorkspaceIdRef.current = next;
            return next;
          });
        }
        navigateToWorkspaceSession(targetWorkspaceId, session?.id ?? null, { replace: true });
        if (session?.id) focusPromptSoon();
      }
    } catch (error) {
      setCreateWorkspaceError(describeWorkspaceCreateError(error));
    } finally {
      setCreateWorkspaceBusy(false);
    }
  }, [baseUrl, client, local, navigateToWorkspaceSession, refreshRouteState, rememberPendingCreatedSession, token]);

  /**
   * Chat-first onboarding: the empty-state composer creates a default chat
   * workspace under the user's home folder instead of asking where to put
   * it. Falls back to the create-workspace modal off desktop.
   */
  const handleChatFirstTask = useCallback((prompt: string, attachments?: ComposerAttachment[]) => {
    void (async () => {
      if (!isDesktopRuntime()) {
        // The cloud workspace is provisioned by Den; boot takeover covers the pre-attach state.
        if (!canCreateWorkspaces()) return;
        handleOpenCreateWorkspace();
        return;
      }
      const home = await getDesktopHomeDir().catch(() => "");
      if (!home) {
        handleOpenCreateWorkspace();
        return;
      }
      const folder = await joinDesktopPath(home, "Sofia App Chat").catch(() => "");
      if (!folder) {
        handleOpenCreateWorkspace();
        return;
      }
      await handleCreateWorkspace("starter", folder, { firstTaskPrompt: prompt, firstTaskAttachments: attachments ?? [] });
    })();
  }, [handleCreateWorkspace, handleOpenCreateWorkspace]);

  const createWorkspaceControlAction = useMemo<SofiaControlAction>(() => ({
    id: "workspace.create",
    label: "Create a local workspace",
    description: "Create a workspace at the given folder path without showing the file picker dialog, optionally labeling its project for analytics.",
    sideEffect: "mutation",
    requiresArgs: true,
    args: [
      { name: "path", type: "string", required: true, description: "Absolute folder path for the new workspace." },
      { name: "projectLabel", type: "string", required: false, description: "Optional project name used to group the workspace's sessions in analytics." },
    ],
    execute: async (args) => {
      if (!canCreateWorkspaces()) return { ok: false, error: "workspace creation is unavailable" };
      const parsed = args as { path?: string; projectLabel?: string } | undefined;
      const folder = parsed?.path?.trim();
      if (!folder) return { ok: false, error: "path is required" };
      const trimmedLabel = parsed?.projectLabel?.trim() ?? "";
      await handleCreateWorkspace("starter", folder, trimmedLabel ? { projectLabel: trimmedLabel } : undefined);
      return { path: folder };
    },
  }), [handleCreateWorkspace]);
  useControlAction(createWorkspaceControlAction);

  const handleCreateRemoteWorkspace = useCallback(async (input: {
    sofiaHostUrl?: string | null;
    sofiaToken?: string | null;
    directory?: string | null;
    displayName?: string | null;
  }) => {
    const baseUrlValue = input.sofiaHostUrl?.trim() ?? "";
    if (!baseUrlValue) return false;
    setCreateWorkspaceRemoteBusy(true);
    setCreateWorkspaceRemoteError(null);
    try {
      const remoteType: "sofia" = "sofia";
      const payload = {
        baseUrl: baseUrlValue,
        sofiaHostUrl: baseUrlValue,
        sofiaToken: input.sofiaToken?.trim() || null,
        displayName: input.displayName?.trim() || null,
        directory: input.directory?.trim() || null,
        remoteType,
      };
      let list: WorkspaceList | null = null;
      if (isDesktopRuntime()) {
        list = await workspaceCreateRemote(payload);
      } else if (client) {
        list = await client.createRemoteWorkspace(payload).catch(() => null);
      }
      if (!list) {
        throw new Error("Sofia App server is unavailable. Start or reconnect the server before connecting a remote workspace.");
      }
      const createdId = resolveWorkspaceListSelectedId(list) || list.workspaces[list.workspaces.length - 1]?.id || "";
      if (createdId) {
        await workspaceSetSelected(createdId).catch(() => undefined);
        await workspaceSetRuntimeActive(createdId).catch(() => undefined);
      }
      setCreateWorkspaceOpen(false);
      // Mark onboarding complete so the /welcome redirect never fires again.
      local.setPrefs((prev) => ({ ...prev, hasCompletedOnboarding: true }));
      await refreshRouteState();
      return true;
    } catch (error) {
      setCreateWorkspaceRemoteError(error instanceof Error ? error.message : t("app.unknown_error"));
      return false;
    } finally {
      setCreateWorkspaceRemoteBusy(false);
    }
  }, [client, local, refreshRouteState]);

  return (
    <WorkspaceProvider
      client={engineClient}
      engineBaseUrl={engineBaseUrl}
      sofiaServerClient={selectedWorkspaceEndpoint?.client ?? null}
      workspaceId={selectedWorkspaceEndpoint?.workspaceId ?? ""}
      selectedWorkspaceRoot={selectedWorkspaceRoot}
    >
    <CodexApprovalModal active={codexApproval} />
    {engineClient && selectedWorkspaceEndpoint && engineBaseUrl && selectedWorkspaceServerToken ? (
      <ReactSessionRuntime
        // Use the server-side workspace id (the one without the `rem_`
        // prefix) so the React Query cache keys session-sync writes match
        // the keys SessionSurface reads from. Otherwise events arrive but
        // the UI never sees them and gets stuck on "thinking".
        workspaceId={selectedWorkspaceEndpoint.workspaceId}
        sessionId={selectedSessionId}
        activeSessionIds={activeSelectedWorkspaceSessionIds}
        engineBaseUrl={engineBaseUrl}
        sofiaToken={selectedWorkspaceServerToken}
        enabled
        onSessionCreated={handleRuntimeSessionCreated}
        onSessionUpdated={handleRuntimeSessionUpdated}
        onSessionDeleted={handleRuntimeSessionDeleted}
      />
    ) : null}
    <SessionPage
      sessionNumberShortcuts={sessionNumberShortcuts}
      selectedSessionId={selectedSessionId}
      selectedWorkspaceId={selectedWorkspaceId}
      selectedWorkspaceDisplay={selectedWorkspace ? {
        id: selectedWorkspace.id,
        name: selectedWorkspace.name ?? undefined,
        displayName: selectedWorkspace.displayNameResolved,
        workspaceType: selectedWorkspace.workspaceType,
      } : { workspaceType: "local" }}
      selectedWorkspaceRoot={selectedWorkspaceRoot}
      selectedWorkspaceError={selectedWorkspaceError}
      runtimeWorkspaceId={selectedWorkspaceEndpoint?.workspaceId || null}
      engineBaseUrl={engineBaseUrl}
      workspaces={workspaces}
      clientConnected={canCreateTask}
      sofiaServerStatus={client ? "connected" : "disconnected"}
      sofiaServerClient={selectedWorkspaceEndpoint?.client ?? client}
      environmentClient={client}
      sofiaServerToken={selectedWorkspaceServerToken}
      developerMode={developerMode}
      codexEngine={codexEngine.enabled ? {
        enabled: true,
        sessions: codexEngine.sessions,
        streaming: codexEngine.streaming,
        error: codexEngine.error,
        config: codexEngine.config,
        createSession: codexEngine.createSession!,
        prompt: codexEngine.prompt!,
        abort: codexEngine.abort!,
        deleteSession: codexEngine.deleteSession!,
      } : null}
      headerStatus={canCreateTask ? t("status.connected") : (modelUnavailableMessage ?? t("session.loading_detail"))}
      busyHint={organizationModelsEmpty ? t("models.organization_models_empty") : effectiveLoading ? t("session.loading_detail") : null}
      startupPhase={effectiveLoading ? "nativeInit" : "ready"}
      providerConnectedIds={providerConnectedIds}
      hasUsableModel={hasUsableModel}
      providers={providers}
      mcpConnectedCount={mcpConnectedCount}
      onSendFeedback={() => {
        platform.openLink(
          buildFeedbackUrl({
            entrypoint: "status-bar",
          }),
        );
      }}
      onOpenSettings={() => handleOpenSettings("/settings/general")}
      onOpenExtensions={() => handleOpenExtensions()}
      onOpenProviderAuth={handleOpenProviderAuth}
      onChatFirstTask={handleChatFirstTask}
      chatFirstBusy={createWorkspaceBusy}
      newTaskComposer={newTaskComposerContext}
      providerAuthModal={sessionProviderAuthSnapshot.providerAuthModalOpen ? {
        open: true,
        loading: false,
        submitting: sessionProviderAuthSnapshot.providerAuthBusy,
        error: sessionProviderAuthSnapshot.providerAuthError,
        preferredProviderId: sessionProviderAuthSnapshot.providerAuthPreferredProviderId,
        workerType: sessionProviderAuthSnapshot.providerAuthWorkerType,
        providers: sessionProviderAuthSnapshot.providerAuthProviders.filter(
          (provider) => !isDesktopProviderBlocked({ providerId: provider.id, checkRestriction: checkDesktopRestriction }),
        ),
        connectedProviderIds: providerConnectedIds,
        authMethods: Object.fromEntries(
          Object.entries(sessionProviderAuthSnapshot.providerAuthMethods).filter(
            ([providerId]) => !isDesktopProviderBlocked({ providerId, checkRestriction: checkDesktopRestriction }),
          ),
        ),
        onSelect: sessionProviderAuthStore.startProviderAuth,
        onSubmitApiKey: async (providerId, apiKey) => {
          const result = await sessionProviderAuthStore.submitProviderApiKey(providerId, apiKey);
          modelPicker.setRecentProviderIds(new Set([providerId]));
          modelPicker.setQuery("");
          modelPicker.setOpen(true);
          return result;
        },
        onSubmitOAuth: sessionProviderAuthStore.completeProviderAuthOAuth,
        onRefreshProviders: sessionProviderAuthStore.refreshProviders,
        onClose: () => sessionProviderAuthStore.closeProviderAuthModal(),
      } : null}
      settingsSlot={
        <SettingsSurface
          embedded
          initialPath="extensions"
          workspaceId={selectedWorkspaceId}
          onClose={() => {
            try {
              window.dispatchEvent(new CustomEvent("sofia-close-right-pane"));
            } catch {
              // ignore
            }
          }}
        />
      }
      primaryTitle={automationsRouteActive ? "Automations" : undefined}
      primarySlot={automationsRouteActive ? (
        <AutomationsPage providerCatalog={providerCatalog} />
      ) : undefined}
      terminalOpen={terminalOpen}
      onTerminalOpenChange={setTerminalOpen}
      onSessionTabsChange={(tabs) => {
        sessionTabNavRef.current = { ...sessionTabNavRef.current, options: tabs };
      }}
      sidebar={{
        workspaceSessionGroups: effectiveWorkspaceSessionGroups,
        selectedWorkspaceId,
        selectedSessionId,
        developerMode: false,
        sessionStatusById: sidebarSessionStatusById,
        connectingWorkspaceId: null,
        workspaceConnectionStateById,
        newTaskDisabled: !canCreateTask,
        sidebarHydratedFromCache: Object.values(sessionsByWorkspaceId).some((list) => list.length > 0),
        startupPhase: effectiveLoading ? "nativeInit" : "ready",
        automationsActive: automationsRouteActive,
        automationsNeedAttention,
        onOpenAutomations: automationsNavigationAvailable
          ? () => {
              navigate(automationsRoute());
            }
          : undefined,
        onSelectWorkspace: async (workspaceId) => {
          if (workspaceId === selectedWorkspaceId) return true;
          setLegacySelectedWorkspaceId(workspaceId);
          writeActiveWorkspaceId(workspaceId || null);
          // Route adoption owns desktop persistence and server activation.
          // Centralizing those effects lets rapid navigation coalesce to the
          // last route instead of racing stale IPC and engine reloads.
          // If we remember what the user last opened here and that session
          // still exists in our local list, navigate. Otherwise stay put.
          const remembered = readLastSessionFor(workspaceId);
          if (remembered && remembered !== selectedSessionId) {
            const known = sessionsByWorkspaceId[workspaceId];
            if (known?.some((session) => session?.id === remembered)) {
              navigateToWorkspaceSession(workspaceId, remembered);
            } else {
              navigateToWorkspaceSession(workspaceId);
            }
          } else {
            navigateToWorkspaceSession(workspaceId);
          }
          return true;
        },
        onOpenSession: (workspaceId, sessionId) => {
          setLegacySelectedWorkspaceId(workspaceId);
          writeActiveWorkspaceId(workspaceId || null);
          writeLastSessionFor(workspaceId, sessionId);
          navigateToWorkspaceSession(workspaceId, sessionId);
        },
        onPrefetchSession: () => {},
        onCreateTaskInWorkspace: (workspaceId, groupId) => {
          void handleCreateTaskInWorkspace(workspaceId).then((sessionId) => {
            if (sessionId && groupId) {
              sessionManagementStore.getState().assignGroup(workspaceId, sessionId, groupId);
            }
          });
        },
        onCreateTaskWithPrompt: (workspaceId, prompt, attachments) => {
          void (async () => {
            const sessionId = await handleCreateTaskInWorkspace(workspaceId);
            if (!sessionId) return;
            const text = prompt.trim();
            const store = useComposerStateStore.getState();
            saveSessionDraft(workspaceId, sessionId, { text: text.replace(/\[attachment [^\]]+\]/g, "").trim(), mode: "prompt" });
            store.setDraft(sessionId, text);
            if (attachments?.length) store.setAttachments(sessionId, attachments);
            // One submission path preserves attachments, model, and workspace.
            // Creation never sends a hidden first turn or falls into another engine.
            if (text || attachments?.length) markComposerAutoSend(sessionId);
            focusPromptSoon();
          })();
        },
        onOpenRenameWorkspace: handleOpenRenameWorkspace,
        onShareWorkspace: handleShareWorkspace,
        onRevealWorkspace: (id) => void handleRevealWorkspace(id),
        onRecoverWorkspace: (workspaceId) => runRemoteWorkspaceConnectionCheck(workspaceId, "recover"),
        onTestWorkspaceConnection: (workspaceId) => runRemoteWorkspaceConnectionCheck(workspaceId, "test"),
        onEditWorkspaceConnection: remoteWorkspaceConnectionEditor.open,
        onForgetWorkspace: (id) => void handleForgetWorkspace(id),
        onOpenCreateWorkspace: handleOpenCreateWorkspace,
        onOpenSessionSearch: () => setSessionSearchOpen(true),
        onReorderWorkspaces: handleReorderWorkspaces,
      }}
      surface={surfaceProps}
      history={{
        canUndo: false,
        canRedo: false,
        busyAction: null,
        onUndo: () => {},
        onRedo: () => {},
      }}
      todos={todos}
      sessionLoadingById={(sessionId) => effectiveLoading && Boolean(sessionId && sessionId === selectedSessionId)}
      shareWorkspaceModal={
        shareWorkspaceState.shareWorkspaceOpen
          ? {
              open: true,
              onClose: shareWorkspaceState.closeShareWorkspace,
              workspaceName: shareWorkspaceState.shareWorkspaceName,
              workspaceDetail: shareWorkspaceState.shareWorkspaceDetail,
              fields: shareWorkspaceState.shareFields,
              remoteAccess:
                isDesktopRuntime() && shareWorkspaceState.shareWorkspace?.workspaceType === "local"
                  ? {
                      enabled: sofiaServerSettings.remoteAccessEnabled === true,
                      busy: remoteAccessRestart.busy,
                      error: remoteAccessRestart.error,
                      status: remoteAccessRestart.status,
                      onSave: handleSaveShareRemoteAccess,
                    }
                  : undefined,
              note: shareWorkspaceState.shareNote,
              onExportConfig:
                shareWorkspaceState.exportDisabledReason === null
                  ? () => {
                      const id = shareWorkspaceState.shareWorkspaceId;
                      if (!id) return;
                      void handleExportWorkspaceConfig(id);
                    }
                  : undefined,
              exportDisabledReason: shareWorkspaceState.exportDisabledReason,
            }
          : null
      }
      activePermission={activePermission}
      permissionReplyBusy={permissionReplyBusy}
      respondPermission={respondPermission}
      activeQuestion={activeQuestion}
      questionReplyBusy={questionReplyBusy}
      respondQuestion={respondQuestion}
      safeStringify={safeStringify}
      onRenameSession={
        codexEngine.enabled && codexEngine.renameSession
          ? codexEngine.renameSession
          : engineClient
          ? async (sessionId, nextTitle) => {
              const trimmed = nextTitle.trim();
              if (!trimmed) return;
              await engineClient.session.update({
                sessionID: sessionId,
                title: trimmed,
                directory: selectedWorkspaceRoot || undefined,
              });
              await refreshRouteState();
            }
          : undefined
      }
      onDeleteSession={
        client && selectedWorkspaceId
          ? async (sessionId) => {
              const endpoint = endpointForWorkspace(selectedWorkspace);
              if (!endpoint) return;
              if (codexEngine.enabled && sessionId.startsWith("codex-") && codexEngine.deleteSession) {
                await codexEngine.deleteSession(sessionId);
              } else {
                await endpoint.client.deleteSession(endpoint.workspaceId, sessionId);
              }
              if (selectedSessionId === sessionId) {
                navigateToWorkspaceSession(selectedWorkspaceId);
              }
              await refreshRouteState();
            }
          : undefined
      }
      onArchiveSession={engineClient || codexEngine.enabled ? handleArchiveSession : undefined}
      statusBar={{
        loading: showPreparingStatus,
        reloadBusy: reloadCoordinator.reloadBusy,
        reloadError: reloadCoordinator.reloadError,
        sofiaConnectState: sessionMcpMaintenance,
      }}
      notFoundMessage={gatedRouteNotFoundMessage}
      mainContentTakeover={
        extensionsMainOpen ? (
          <SettingsSurface
            standaloneExtensions
            workspaceId={selectedWorkspaceId || undefined}
          />
        ) : cloudWorkspaceMainContentTakeover
      }
      mainContentTitle={extensionsMainOpen ? t("settings.tab_extensions") : undefined}
      extensionsActive={extensionsMainOpen}
      onAccessibleTargetsChange={setPaletteAccessibleTargets}
    />
    <CreateWorkspaceModal
      open={createWorkspaceOpen}
      onClose={() => {
        setCreateWorkspaceOpen(false);
        setCreateWorkspaceError(null);
      }}
      onConfirm={handleCreateWorkspace}
      onConfirmRemote={handleCreateRemoteWorkspace}
      onPickFolder={async () => singlePickedDirectory(await pickDirectory({ title: t("onboarding.authorize_folder") }))}
      submitting={createWorkspaceBusy}
      localError={createWorkspaceError}
      localDisabled={!platform.capabilities.nativeFilePicker}
      localDisabledReason={
        platform.capabilities.nativeFilePicker
          ? undefined
          : t("app.local_disabled_reason")
      }
      remoteSubmitting={createWorkspaceRemoteBusy}
      remoteError={createWorkspaceRemoteError}
    />
    <CreateRemoteWorkspaceModal
      open={remoteWorkspaceConnectionEditor.workspace !== null}
      onClose={remoteWorkspaceConnectionEditor.close}
      onConfirm={(input) => void remoteWorkspaceConnectionEditor.save(input)}
      initialValues={remoteWorkspaceConnectionEditor.initialValues}
      submitting={remoteWorkspaceConnectionEditor.busy}
      error={remoteWorkspaceConnectionEditor.error}
      title={t("dashboard.edit_remote_workspace_title")}
      subtitle={t("dashboard.edit_remote_workspace_subtitle")}
      confirmLabel={t("dashboard.edit_remote_workspace_confirm")}
    />
    <RenameWorkspaceModal
      open={renameWorkspaceId !== null}
      title={renameWorkspaceTitle}
      busy={renameWorkspaceBusy}
      canSave={!renameWorkspaceBusy && renameWorkspaceTitle.trim().length > 0}
      onClose={() => {
        if (renameWorkspaceBusy) return;
        setRenameWorkspaceId(null);
        setRenameWorkspaceTitle("");
      }}
      onSave={() => void handleSaveRenameWorkspace()}
      onTitleChange={setRenameWorkspaceTitle}
    />
    <CommandPalette
      open={commandPaletteOpen}
      onClose={() => setCommandPaletteOpen(false)}
      onCreateNewSession={() => {
        if (selectedWorkspaceId) {
          void handleCreateTaskInWorkspace(selectedWorkspaceId);
        }
      }}
      onOpenSession={(workspaceId, sessionId) => navigateToWorkspaceSession(workspaceId, sessionId)}
      onOpenSettings={(route) => handleOpenSettings(route ?? "/settings/general")}
      onOpenExtensions={() => handleOpenExtensions()}
      onOpenModelPicker={() => {
        modelPicker.setQuery("");
        modelPicker.setRecentProviderIds(new Set());
        window.requestAnimationFrame(() => modelPicker.setOpen(true));
      }}
      selectedModelLabel={modelLabel}
      accessibleTargets={paletteAccessibleTargets}
      onOpenAccessibleTarget={(target) => {
        try {
          window.dispatchEvent(new CustomEvent("sofia-open-accessible-target", { detail: target }));
        } catch {
          // ignore event dispatch failures
        }
      }}
      onHideAccessibleTarget={(target) => {
        try {
          window.dispatchEvent(new CustomEvent("sofia-hide-accessible-target", { detail: target }));
        } catch {
          // ignore event dispatch failures
        }
      }}
      sessions={paletteSessionOptions}
      sessionGroups={paletteSessionGroups}
      currentSessionForGroupMove={currentSessionForGroupMove}
      currentSessionGroupId={currentSessionGroupId}
      onMoveCurrentSessionToGroup={handleMoveCurrentSessionToGroup}
      extraItems={[...(sessionFindPaletteItem ? [sessionFindPaletteItem] : []), sessionSearchPaletteItem, ...terminalPaletteItems, developerModePaletteItem, diagnosticsCopyPaletteItem, diagnosticsExportPaletteItem, nextSessionTabPaletteItem, prevSessionTabPaletteItem, reloadConfigPaletteItem]}
      listAgents={listAgents}
      selectedAgent={selectedAgent}
      onSelectAgent={setSelectedAgent}
    />
    <SessionSearchDialog
      open={sessionSearchOpen}
      onClose={() => setSessionSearchOpen(false)}
      sessions={paletteSessionOptions}
      fetchMessages={sessionSearchFetcher}
      onOpenSession={(workspaceId, sessionId) => navigateToWorkspaceSession(workspaceId, sessionId)}
    />
    <ModelPickerModal
      open={modelPicker.open}
      options={modelPicker.options}
      organizationModelsEmpty={organizationModelsEmpty}
      organizationModelsSettingsUrl={organizationModelsSettingsUrl}

      query={modelPicker.query}
      setQuery={modelPicker.setQuery}
      subtitle={selectedModelUnavailable ? MODEL_PICKER_UNAVAILABLE_SUBTITLE : undefined}
      target="default"
      current={
        (modelPickerSessionId ? getSessionModelSelection(modelPickerSessionId)?.model : null)
          ?? local.prefs.defaultModel
          ?? ({ providerID: "", modelID: "" } satisfies ModelRef)
      }
      onSelect={(next: ModelRef) => {
        if (modelPickerSessionId) {
          // Keep the conversation's own model, and also remember it as the
          // last used default so a newly created session starts on it.
          useSessionModelStore.getState().setModel(modelPickerSessionId, next);
          local.setPrefs((previous) => ({
            ...previous,
            defaultModel: next,
            modelVariant: previous.defaultModel?.providerID === next.providerID && previous.defaultModel.modelID === next.modelID
              ? previous.modelVariant
              : null,
          }));
          setModelPickerSessionId(null);
        } else {
          local.setPrefs((previous) => ({
            ...previous,
            defaultModel: next,
            modelVariant: previous.defaultModel?.providerID === next.providerID && previous.defaultModel.modelID === next.modelID
              ? previous.modelVariant
              : null,
          }));
        }
        modelPicker.setOpen(false);
        focusPromptSoon();
      }}
      disabledProviders={disabledProviderIds}
      onBehaviorChange={() => {}}
      onToggleProvider={async (providerId, enable) => {
        if (!engineClient) return;
        try {
          const config = unwrap(await engineClient.config.get());
          const current = disabledProvidersFromConfig(config);
          const next = enable
            ? current.filter((id: string) => id !== providerId)
            : [...current, providerId];
          const result = await updateManagedDisabledProviders({
            engineClient,
            sofiaClient: selectedWorkspaceEndpoint?.client ?? null,
            workspaceId: selectedWorkspaceEndpoint?.workspaceId ?? null,
            workspaceType: selectedWorkspace?.workspaceType ?? "local",
            disabledProviders: next,
            currentConfig: config,
            markReloadRequired: () => {
              reloadCoordinator.markReloadRequired("config", {
                type: "config",
                name: "runtime-engine-config.json",
                action: "updated",
              });
            },
          });
          setDisabledProviderIds(result.disabledProviders);
        } catch {}
      }}
      onOpenSettings={() => {
        modelPicker.setOpen(false);
        handleOpenSettings("/settings/general");
      }}
      onClose={() => { modelPicker.setOpen(false); modelPicker.setRecentProviderIds(new Set()); }}
      sofiaModelsEntitled={sofiaModelsEntitled}
      sofiaModelsSyncing={sofiaModelsSyncing}
      onRefreshOrganizationModels={refreshOrganizationModelAccess}
      restrictToCloud={restrictToCloudProviders}
    />
    </WorkspaceProvider>
  );
}
