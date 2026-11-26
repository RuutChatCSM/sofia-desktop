/** @jsxImportSource react */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type * as React from "react";
import { useSearchParams } from "react-router";
import { ArrowLeft, ChevronDown, Minus, MessageCircle, PanelRight, PanelTop } from "lucide-react";

import type {
  BrowserSessionDockLayout,
  BrowserSessionDockSize,
} from "@/app/lib/desktop-types";
import type { WorkspaceInfo } from "@/app/lib/desktop";
import { workspaceBootstrap } from "@/app/lib/desktop";
import { createClient, unwrap } from "@/app/lib/engine";
import { listCommands } from "@/app/lib/engine-session";
import { isDesktopRuntime, isSandboxWorkspace } from "@/app/utils";
import type { ModelRef, SlashCommandOption } from "@/app/types";
import { getResolvedThemeMode, subscribeToTheme } from "@/app/theme";
import { t } from "@/i18n";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { resolveWorkspaceEndpoint, workspaceServerId, type ResolvedWorkspaceEndpoint } from "@/app/lib/workspace-endpoint";
import { useLocal } from "@/react-app/kernel/local-provider";
import { useCodexEngine } from "@/react-app/domains/session/use-codex-engine";
import { useCodexSessionStore } from "@/react-app/domains/session/codex-session-store";
import { SessionSurface } from "@/react-app/domains/session/surface/session-surface";
import { WorkspaceProvider } from "./workspace-provider";
import { getSessionModelSelection } from "@/react-app/domains/session/surface/session-model-store";
import { sendCodexDraft } from "@/react-app/domains/session/sync/codex-composer-send";
import { IDLE_CLOUD_MCP_SUBMISSION_GATE_STATE } from "@/react-app/domains/connections/cloud-mcp-submit-readiness";
import { getElectronBrowser } from "@/react-app/domains/session/panel/utils";
import { resolveSofiaConnection } from "./sofia-connection";

type DockWorkspaceState =
  | { status: "loading" }
  | { status: "error"; error: string }
  | {
      status: "ready";
      endpoint: ResolvedWorkspaceEndpoint;
      workspace: WorkspaceInfo;
      hostToken: string | undefined;
      workspaceRoot: string;
    };

function readDockSize(value: string | null): BrowserSessionDockSize {
  return value === "bar" || value === "bubble" || value === "panel" ? value : "panel";
}

/**
 * Resolve only the one workspace this dock shows. The dock is a second renderer,
 * so it cannot borrow the main window's React state; it asks the desktop bridge
 * for the same workspace list and local server connection the session route uses.
 */
function useDockWorkspace(workspaceId: string): DockWorkspaceState {
  const [state, setState] = useState<DockWorkspaceState>({ status: "loading" });
  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    void (async () => {
      if (!workspaceId) {
        if (!cancelled) setState({ status: "error", error: "No session is selected." });
        return;
      }
      try {
        const connection = await resolveSofiaConnection();
        const localServer = { baseUrl: connection.normalizedBaseUrl, token: connection.resolvedToken };
        const list = isDesktopRuntime() ? await workspaceBootstrap().catch(() => null) : null;
        const workspace = list?.workspaces.find((candidate) =>
          candidate.id === workspaceId
          || workspaceServerId(candidate) === workspaceId
          || candidate.sofiaWorkspaceId === workspaceId,
        ) ?? {
          id: workspaceId,
          name: workspaceId,
          path: "",
          preset: "",
          workspaceType: "local" as const,
        };
        const endpoint = resolveWorkspaceEndpoint(workspace, localServer);
        if (!endpoint) {
          if (!cancelled) setState({ status: "error", error: "The workspace server is not reachable." });
          return;
        }
        if (!cancelled) {
          setState({
            status: "ready",
            endpoint,
            workspace,
            hostToken: workspace.workspaceType === "remote"
              ? workspace.sofiaHostToken ?? undefined
              : connection.resolvedHostToken || connection.hostInfo?.hostToken || undefined,
            workspaceRoot: workspace.directory ?? workspace.path ?? "",
          });
        }
      } catch (error) {
        if (!cancelled) {
          setState({ status: "error", error: error instanceof Error ? error.message : "The workspace could not be opened." });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);
  return state;
}

export function DockSessionRoute() {
  const [searchParams] = useSearchParams();
  const workspaceParam = searchParams.get("workspace")?.trim() ?? "";
  const sessionId = searchParams.get("session")?.trim() ?? "";
  const [layout, setLayout] = useState<BrowserSessionDockLayout>(() => ({
    corner: "bottom-right",
    size: readDockSize(searchParams.get("size")),
  }));
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const lastNonBubbleRef = useRef<Exclude<BrowserSessionDockSize, "bubble">>("panel");
  const dragRef = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const composerWasFocusedRef = useRef(false);
  const pickerExpandedFromBarRef = useRef(false);
  const local = useLocal();
  const workspaceState = useDockWorkspace(workspaceParam);
  const endpoint = workspaceState.status === "ready" ? workspaceState.endpoint : null;
  const displayWorkspaceId = workspaceState.status === "ready" ? workspaceState.workspace.id : workspaceParam;
  const codexEngine = useCodexEngine(
    endpoint
      ? {
          baseUrl: endpoint.baseUrl,
          token: endpoint.token,
          hostToken: workspaceState.status === "ready" ? workspaceState.hostToken : undefined,
          workspaceId: endpoint.workspaceId,
          displayWorkspaceId,
        }
      : null,
    sessionId || null,
    { attention: false },
  );
  const engineClient = useMemo(
    () => endpoint
      ? createClient(endpoint.engineBaseUrl, undefined, { token: endpoint.token, mode: "sofia" })
      : null,
    [endpoint?.engineBaseUrl, endpoint?.token],
  );
  const sessionEntry = useCodexSessionStore((state) => sessionId ? state.sessions[sessionId] : undefined);
  const running = sessionEntry?.session.status === "running" || codexEngine.streaming;
  const title = sessionEntry?.session.title?.trim() || (sessionId ? "New conversation" : "Sofia");
  const dark = useSyncExternalStore(subscribeToTheme, getResolvedThemeMode, getResolvedThemeMode) === "dark";

  useEffect(() => {
    const browser = getElectronBrowser();
    if (!browser) return;
    const offLayout = browser.onSessionDockLayout?.((next) => setLayout(next));
    const offTheme = browser.onSessionDockTheme?.((isDark) => {
      document.documentElement.dataset.theme = isDark ? "dark" : "light";
      document.documentElement.style.colorScheme = isDark ? "dark" : "light";
    });
    const pendingLayout = browser.getSessionDockLayout?.();
    if (pendingLayout) {
      void pendingLayout.then((next) => {
        if (next) setLayout(next);
      }).catch(() => undefined);
    }
    browser.sessionDockReady?.();
    return () => {
      offLayout?.();
      offTheme?.();
    };
  }, []);

  useEffect(() => {
    if (layout.size !== "bubble") lastNonBubbleRef.current = layout.size;
  }, [layout.size]);

  const applySize = useCallback((size: BrowserSessionDockSize) => {
    const focused = document.activeElement instanceof Element
      && Boolean(document.activeElement.closest(".sofia-composer-panel"));
    if (focused && size === "bubble") composerWasFocusedRef.current = true;
    const next = { ...layoutRef.current, size };
    setLayout(next);
    getElectronBrowser()?.setSessionDockLayout?.(next);
    requestAnimationFrame(() => {
      // Hiding the composer for the bubble blurs it; restore focus when the
      // card returns, without remounting the editor (the draft stays intact).
      if (size === "bubble" || !(focused || composerWasFocusedRef.current)) return;
      const editor = document.querySelector<HTMLElement>("[data-sofia-composer-editor]");
      editor?.focus();
      composerWasFocusedRef.current = false;
    });
  }, []);

  const startDrag = useCallback((event: React.PointerEvent<HTMLElement>, allowButtons: boolean) => {
    if (event.button !== 0) return;
    const target = event.target;
    if (!allowButtons && target instanceof Element && target.closest("button")) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { x: event.screenX, y: event.screenY, moved: false };
  }, []);

  const moveDrag = useCallback((event: React.PointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = event.screenX - drag.x;
    const dy = event.screenY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    getElectronBrowser()?.dragSessionDock?.(dx, dy, "move");
  }, []);

  const endDrag = useCallback((event: React.PointerEvent<HTMLElement>, cancelled: boolean) => {
    const drag = dragRef.current;
    if (!drag) return false;
    getElectronBrowser()?.dragSessionDock?.(
      event.screenX - drag.x,
      event.screenY - drag.y,
      cancelled ? "cancel" : "end",
    );
    dragRef.current = null;
    return !drag.moved;
  }, []);

  const selectedModel: ModelRef = local.prefs.defaultModel
    ?? (codexEngine.config?.defaultProviderId && codexEngine.config.model
      ? { providerID: codexEngine.config.defaultProviderId, modelID: codexEngine.config.model }
      : { providerID: "", modelID: "" });
  const modelVariant = local.prefs.modelVariant ?? null;
  const selectedAgent = local.prefs.selectedAgent;

  const listAgents = useCallback(async () => {
    if (!engineClient) return [];
    return unwrap(await engineClient.app.agents());
  }, [engineClient]);
  const listSlashCommands = useCallback(async (): Promise<SlashCommandOption[]> => {
    if (!engineClient) return [];
    return listCommands(engineClient, workspaceState.status === "ready" ? workspaceState.workspaceRoot || undefined : undefined);
  }, [engineClient, workspaceState]);
  const searchFiles = useCallback(async (query: string) => {
    if (!engineClient) return [];
    const result = unwrap(await engineClient.find.files({
      query: query.trim(),
      dirs: "true",
      limit: 50,
      directory: workspaceState.status === "ready" ? workspaceState.workspaceRoot || undefined : undefined,
    }));
    return result;
  }, [engineClient, workspaceState]);

  const setDockTheme = useCallback((mode: "dark" | "light") => {
    document.documentElement.dataset.theme = mode;
    document.documentElement.style.colorScheme = mode;
  }, []);
  useEffect(() => {
    setDockTheme(dark ? "dark" : "light");
  }, [dark, setDockTheme]);

  const bubble = layout.size === "bubble";
  const bar = layout.size === "bar";

  // The session surface reads its workspace (engine client, server client,
  // root) from this context, exactly as it does under SessionRoute.
  return (
    <WorkspaceProvider
      client={engineClient}
      engineBaseUrl={endpoint?.engineBaseUrl ?? ""}
      sofiaServerClient={endpoint?.client ?? null}
      workspaceId={endpoint?.workspaceId ?? ""}
      selectedWorkspaceRoot={workspaceState.status === "ready" ? workspaceState.workspaceRoot : ""}
    >
    <div className="h-full w-full overflow-hidden bg-transparent" data-dock-size={layout.size}>
      <section
        role="region"
        aria-label="Sofia session"
        className={`h-full w-full ${bubble ? "hidden" : "flex flex-col"} overflow-hidden border border-dls-border bg-dls-canvas shadow-[0_18px_48px_rgba(0,0,0,0.24)] ${bar ? "rounded-[16px]" : "rounded-[18px]"}`}
      >
        <header
          data-dock-drag-handle=""
          className={`flex shrink-0 items-center gap-1.5 border-b border-dls-border/70 px-2 ${bar ? "h-7" : "h-10"} cursor-grab active:cursor-grabbing`}
          onPointerDown={(event) => startDrag(event, false)}
          onPointerMove={moveDrag}
          onPointerUp={(event) => { endDrag(event, false); }}
          onPointerCancel={(event) => { endDrag(event, true); }}
        >
          <span
            className="sofia-orbit ml-0.5"
            data-tone="working"
            aria-hidden="true"
            style={{ width: bar ? 10 : 12, height: bar ? 10 : 12, opacity: running ? 1 : 0.45, animation: running ? undefined : "none" }}
          />
          <DropdownMenu>
            <DropdownMenuTrigger
              type="button"
              className="flex min-w-0 flex-1 items-center gap-1 rounded-md px-1 py-1 text-left text-dls-text transition-colors hover:bg-dls-hover"
              aria-label={`Session menu for ${title}`}
            >
              <span className={`min-w-0 truncate font-semibold ${bar ? "text-[11px]" : "text-[12.5px]"}`}>{title}</span>
              <ChevronDown className="size-3 shrink-0 text-dls-secondary" aria-hidden="true" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-52">
              <DropdownMenuItem onSelect={() => getElectronBrowser()?.backToChatFromSessionDock?.()}>
                <ArrowLeft className="mr-2 size-3.5" aria-hidden="true" />
                Back to chat
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => getElectronBrowser()?.openSidebarFromSessionDock?.()}>
                <PanelRight className="mr-2 size-3.5" aria-hidden="true" />
                Open in sidebar
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {bar ? (
            <button
              type="button"
              className="inline-flex size-6 items-center justify-center rounded-md text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text"
              aria-label="Expand Sofia session dock"
              title="Expand"
              onClick={() => applySize("panel")}
            >
              <PanelTop className="size-3.5" aria-hidden="true" />
            </button>
          ) : (
            <button
              type="button"
              className="inline-flex size-7 items-center justify-center rounded-md text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text"
              aria-label="Compact Sofia session dock"
              title="Compact bar"
              onClick={() => applySize("bar")}
            >
              <PanelTop className="size-3.5" aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            className="inline-flex size-7 items-center justify-center rounded-md text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text"
            aria-label="Minimize Sofia session dock"
            title="Minimize"
            onClick={() => applySize("bubble")}
          >
            <Minus className="size-4" aria-hidden="true" />
          </button>
        </header>
        <div className="relative flex min-h-0 flex-1 flex-col">
          {workspaceState.status === "ready" && endpoint && sessionId ? (
            <SessionSurface
              variant={bar ? "dock-bar" : "dock"}
              client={endpoint.client}
              workspaceId={displayWorkspaceId}
              workspaceRoot={workspaceState.workspaceRoot}
              sessionId={sessionId}
              isControlTarget={false}
              engineBaseUrl={endpoint.engineBaseUrl}
              sofiaToken={endpoint.token}
              developerMode={false}
              modelLabel={selectedModel.modelID || "Select model"}
              onModelClick={() => undefined}
              modelPickerOpen={false}
              selectedModel={selectedModel}
              onModelPickerOpenChange={(open) => {
                // The bar is too short for the model popover; let it borrow
                // the panel while the picker is open, then return.
                if (open && layoutRef.current.size === "bar") {
                  pickerExpandedFromBarRef.current = true;
                  applySize("panel");
                } else if (!open && pickerExpandedFromBarRef.current && layoutRef.current.size === "panel") {
                  pickerExpandedFromBarRef.current = false;
                  applySize("bar");
                }
              }}
              onModelChange={(model) => local.setPrefs((previous) => ({ ...previous, defaultModel: model }))}
              onSendDraft={async (draft, targetSessionId) => {
                if (!codexEngine.prompt) return { outcome: "cancelled", reason: "context_changed" };
                const sessionModel = getSessionModelSelection(targetSessionId);
                return sendCodexDraft({
                  draft,
                  sessionId: targetSessionId,
                  workspaceRoot: workspaceState.workspaceRoot,
                  endpoint,
                  model: sessionModel?.model ?? local.prefs.defaultModel,
                  prompt: codexEngine.prompt,
                  steer: codexEngine.steer,
                });
              }}
              cloudMcpSubmissionState={IDLE_CLOUD_MCP_SUBMISSION_GATE_STATE}
              onOpenConnect={() => undefined}
              onDraftChange={() => undefined}
              attachmentsEnabled
              attachmentsDisabledReason={null}
              modelVariantLabel={modelVariant ?? ""}
              modelVariant={modelVariant}
              onModelVariantChange={(value) => local.setPrefs((previous) => ({ ...previous, modelVariant: value }))}
              agentLabel={selectedAgent ? selectedAgent.charAt(0).toUpperCase() + selectedAgent.slice(1) : t("session.default_agent")}
              selectedAgent={selectedAgent}
              listAgents={listAgents}
              onSelectAgent={(agent) => local.setPrefs((previous) => ({ ...previous, selectedAgent: agent }))}
              listCommands={listSlashCommands}
              recentFiles={[]}
              searchFiles={searchFiles}
              isRemoteWorkspace={workspaceState.workspace.workspaceType === "remote"}
              isSandboxWorkspace={isSandboxWorkspace(workspaceState.workspace)}
              providerConnectedCount={1}
            />
          ) : (
            <div className="flex h-full items-center justify-center px-6 text-center text-xs text-dls-secondary" role="status">
              {workspaceState.status === "error" ? workspaceState.error : sessionId ? "Opening the conversation…" : "Open a conversation to use the dock."}
            </div>
          )}
        </div>
      </section>
      {bubble ? (
        <button
          type="button"
          aria-label={running ? "Sofia is working. Restore the session." : "Restore the Sofia session."}
          className="flex size-full cursor-grab items-center justify-center rounded-full border border-dls-border bg-dls-canvas text-dls-text shadow-[0_10px_28px_rgba(0,0,0,0.28)] transition-colors hover:bg-dls-hover active:cursor-grabbing"
          onPointerDown={(event) => startDrag(event, true)}
          onPointerMove={moveDrag}
          onPointerUp={(event) => {
            const tapped = endDrag(event, false);
            if (tapped) applySize(lastNonBubbleRef.current);
          }}
          onPointerCancel={(event) => { endDrag(event, true); }}
        >
          {running ? (
            <span className="sofia-orbit" style={{ width: 24, height: 24 }} aria-hidden="true" />
          ) : (
            <MessageCircle className="size-6" aria-hidden="true" />
          )}
        </button>
      ) : null}
    </div>
    </WorkspaceProvider>
  );
}
