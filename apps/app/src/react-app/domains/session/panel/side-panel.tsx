/** @jsxImportSource react */
import * as React from "react";
import { FileDiff, Globe, Loader2, Plus, X, Maximize2, Minimize2, PictureInPicture2, FolderOpen } from "lucide-react";
import { useDragControls } from "motion/react";

import type { SofiaServerClient } from "@/app/lib/sofia-server";
import { PanelTab, PanelTabClose, PanelTabItem, PanelTabList } from "@/components/panel-tabs";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import { ArtifactIcon } from "../artifacts/artifact-icon";
import { useChangeSetStore } from "../changes/change-set-store";
import { ReviewPane, type ReviewScope } from "../changes/review-pane";
import type { FileChange } from "../changes/turn-change-set";
import { loadRepositoryChanges } from "../codex-session-store";
import { ArtifactPanel } from "../artifacts/artifact-panel";
import {
  type BrowserPanelTab,
  usePanelTabStore,
  type PanelTab as PanelTabEntry,
  useActivePanelTab,
  useSessionPanelState,
} from "./panel-tab-store";
import { useControlAction, type SofiaControlAction } from "../../../shell/control/control-provider";
import type { OpenTarget } from "../artifacts/open-target";
import { dispatchBrowserPresentation } from "./browser-presentation";
import { FileTypeIcon } from "./file-type-icon";
import { WorkspaceFiles } from "./workspace-files";
import { BrowserView } from "./browser-view";
import { useSidePanelTabs } from "./use-side-panel-tabs";
import { handlePanelEscape, PanelEmpty } from "./panel-empty";
import { getElectronBrowser, getNativeMenuPoint } from "./utils";


type SidePanelProps = {
  sessionId: string;
  client: SofiaServerClient | null;
  workspaceId: string | null;
  workspaceRoot: string;
  isRemoteWorkspace?: boolean;
  onClose: () => void;
  expanded?: boolean;
  onToggleExpand?: () => void;
  onOpenExtensions?: () => void;
  onOpenVoice?: () => void;
};

// HMR can remount this module without unmounting BrowserPanelContent, leaving
// the native Electron browser overlay visible — hide it before the module reloads.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    getElectronBrowser()?.hide?.();
  });
}

const MARKDOWN_PRIMITIVE_ARTIFACT_CONTENT = `# Artifact Markdown Proof

The artifact preview keeps **outside-chat Markdown** readable with inline \`surface renderer\`, a fenced code block, and [Sofia](https://sofia.ruut.chat).

\`\`\`ts
const surface = "shared markdown primitive";
console.log(surface);
\`\`\``;

type SidePanelTabProps = {
  tab: PanelTabEntry;
  active: boolean;
  onSelect: (tabId: string) => void;
  onClose: (tab: PanelTabEntry) => void;
};

function SidePanelTab({ tab, active, onSelect, onClose }: SidePanelTabProps) {
  const dragControls = useDragControls();
  const tabRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (active) {
      tabRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }, [active]);

  const showBrowserTabContextMenu = (point?: { clientX: number; clientY: number }) => {
    void getElectronBrowser()?.showTabContextMenu?.(
      tab.id,
      getNativeMenuPoint(tabRef.current, point),
    );
  };

  return (
    <PanelTabItem
      value={tab.id}
      id={tab.id}
      dragControls={tab.type === "browser" ? dragControls : undefined}
      onContextMenu={tab.type === "browser" ? (event: React.MouseEvent<HTMLDivElement>) => {
        event.preventDefault();
        event.stopPropagation();
        showBrowserTabContextMenu({ clientX: event.clientX, clientY: event.clientY });
      } : undefined}
    >
      <div ref={tabRef} className="group/panel-tab relative">
        <PanelTab
          active={active}
          data-testid={`panel-tab-${tab.id}`}
          onClick={() => onSelect(tab.id)}
          onPointerDown={tab.type === "browser" ? (event) => {
            if (event.button !== 0) {
              return;
            }

            dragControls.start(event);
          } : undefined}
          onKeyDown={tab.type === "browser" ? (event: React.KeyboardEvent<HTMLButtonElement>) => {
            if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) {
              return;
            }

            event.preventDefault();
            showBrowserTabContextMenu();
          } : undefined}
          title={tab.label}
          aria-label={`Select tab: ${tab.label}`}
        >
          {tab.type === "browser" ? (
            tab.favicon ? (
              <img src={tab.favicon} alt="" className="size-3.5 shrink-0 rounded-[2px]" />
            ) : tab.pageState.status === "loading" ? (
              <Loader2 className="animate-spin" />
            ) : (
              <Globe />
            )
          ) : tab.type === "changes" ? (
            <FileDiff className="size-3.5 shrink-0" />
          ) : tab.type === "artifact" ? (
            <ArtifactIcon type={tab.preview} />
          ) : tab.type === "files" && tab.path ? (
            <FileTypeIcon path={tab.path} />
          ) : (
            <FolderOpen />
          )}
          <span className="min-w-0 flex-1 truncate text-left">{tab.label}</span>
        </PanelTab>
        <PanelTabClose
          active={active}
          label={tab.label}
          onClose={() => onClose(tab)}
        />
      </div>
    </PanelTabItem>
  );
}

/**
 * The review workspace. Unlike a modal sheet this is a docked pane inside the
 * session's resizable split, so code has room: the file list, the side-by-side
 * diff, and (later) hunk actions and inline comments all live here.
 */
function ChangesPanel({
  sessionId,
  changeSetId,
  filePath,
  onOpenFile,
}: {
  sessionId: string;
  changeSetId: string;
  filePath?: string;
  onOpenFile: (path: string) => void;
}) {
  const changeSet = useChangeSetStore((state) => state.byId[changeSetId] ?? null);
  const [scope, setScope] = React.useState<ReviewScope>("last-turn");
  const [repositoryFiles, setRepositoryFiles] = React.useState<FileChange[] | null>(null);
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    if (scope === "last-turn") return;
    let cancelled = false;
    setLoading(true);
    void loadRepositoryChanges(sessionId, scope).then((files) => {
      if (cancelled) return;
      setRepositoryFiles(files);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [scope, sessionId]);

  return (
    <div className="min-h-0 flex-1 overflow-hidden">
      <ReviewPane
        scope={scope}
        onScopeChange={setScope}
        changeSet={changeSet}
        repositoryFiles={repositoryFiles}
        loading={loading}
        initialPath={filePath}
        onOpenFile={onOpenFile}
      />
    </div>
  );
}

export function SidePanel({
  sessionId,
  client,
  workspaceId,
  workspaceRoot,
  isRemoteWorkspace = false,
  onClose,
  expanded = false,
  onToggleExpand,
  onOpenExtensions,
  onOpenVoice,
}: SidePanelProps) {
  const { tabs } = useSessionPanelState(sessionId);
  const activeTab = useActivePanelTab(sessionId);
  const isBrowserAvailable = Boolean(getElectronBrowser());

  const { closeTab, selectTab, reorderTabs } = useSidePanelTabs(sessionId);
  const openBrowserPage = async (url?: string) => {
    const browser = getElectronBrowser();
    const created = await browser?.createTab?.(url);
    const state = await browser?.getState?.();
    if (!created || !state) return;
    const store = usePanelTabStore.getState();
    store.syncBrowserTabs(sessionId, state.tabs ?? [], created.tabId);
    store.selectTab(sessionId, created.tabId);
  };
  const openPanelTab = (type: "start" | "files", path?: string) => {
    const id = type === "files" ? `workspace-files:${sessionId}` : `start:${crypto.randomUUID()}`;
    const store = usePanelTabStore.getState();
    store.openTab(sessionId, { id, type, label: type === "files" ? path ? path.split("/").pop() ?? path : "Files" : "New tab", path });
    store.selectTab(sessionId, id);
  };

  const seedArtifactOverflowControlAction = React.useMemo<SofiaControlAction | null>(() => {
    if (!import.meta.env.DEV) return null;

    return {
      id: "eval.artifact_tabs.seed_overflow",
      label: "Seed artifact tab overflow eval data",
      description: "Create many markdown artifacts and open them in the right-side artifact tab strip.",
      sideEffect: "mutation",
      disabled: !client || !workspaceId,
      args: [
        { name: "count", type: "number", description: "Number of artifact tabs to create." },
        { name: "longNameLast", type: "boolean", description: "Give the last (active) artifact a very long filename to exercise header truncation." },
      ],
      previewArgs: { count: 18 },
      execute: async (args) => {
        if (!client || !workspaceId) return { ok: false, error: "Workspace client is not ready." };

        let count = 18;
        if (args && typeof args === "object" && "count" in args && typeof args.count === "number") {
          count = Math.max(12, Math.min(30, Math.floor(args.count)));
        }
        const longNameLast = Boolean(args && typeof args === "object" && "longNameLast" in args && args.longNameLast);

        const targets: OpenTarget[] = [];
        const store = usePanelTabStore.getState();

        for (let index = 1; index <= count; index += 1) {
          const padded = String(index).padStart(2, "0");
          const baseName = longNameLast && index === count
            ? `sofia-self-managed-subscription-and-licensing-overview-very-long-${padded}`
            : `overflow-tab-${padded}`;
          const value = `artifacts/${baseName}.md`;
          const label = `${baseName}.md`;
          const content = `# Overflow tab ${padded}\n\nGenerated by the artifact tab overflow eval.\n`;

          await client.writeWorkspaceFile(workspaceId, { path: value, content, baseUpdatedAt: null });

          const target: OpenTarget = {
            id: `file:${value}`,
            kind: "file",
            value,
            name: label,
            preview: "markdown",
            confidence: 100,
            reason: "eval",
            exists: true,
            size: content.length,
          };

          targets.push(target);
          store.openTab(sessionId, {
            id: target.id,
            type: "artifact",
            label: target.name,
            preview: target.preview,
          });
        }

        store.syncTranscriptArtifacts(sessionId, targets);
        store.selectTab(sessionId, targets[targets.length - 1]?.id ?? "");

        return { ok: true, count: targets.length, activeTabId: targets[targets.length - 1]?.id ?? null };
      },
    };
  }, [client, sessionId, workspaceId]);
  useControlAction(seedArtifactOverflowControlAction);

  const seedMarkdownPrimitiveArtifactControlAction = React.useMemo<SofiaControlAction | null>(() => {
    if (!import.meta.env.DEV) return null;

    return {
      id: "eval.markdown_primitive.seed_artifact",
      label: "Seed markdown primitive artifact proof",
      description: "Create a deterministic markdown artifact and open it in the preview panel.",
      sideEffect: "mutation",
      disabled: !client || !workspaceId,
      execute: async () => {
        if (!client || !workspaceId) return { ok: false, error: "Workspace client is not ready." };

        const value = "artifacts/markdown-primitive-proof.md";
        await client.writeWorkspaceFile(workspaceId, {
          path: value,
          content: MARKDOWN_PRIMITIVE_ARTIFACT_CONTENT,
          baseUpdatedAt: null,
        });

        const target: OpenTarget = {
          id: `file:${value}`,
          kind: "file",
          value,
          name: "markdown-primitive-proof.md",
          preview: "markdown",
          confidence: 100,
          reason: "eval",
          exists: true,
          size: MARKDOWN_PRIMITIVE_ARTIFACT_CONTENT.length,
        };

        const store = usePanelTabStore.getState();
        store.syncTranscriptArtifacts(sessionId, [target]);
        store.openTab(sessionId, { id: target.id, type: "artifact", label: target.name, preview: target.preview });
        store.selectTab(sessionId, target.id);

        return { ok: true, activeTabId: target.id, path: value };
      },
    };
  }, [client, sessionId, workspaceId]);
  useControlAction(seedMarkdownPrimitiveArtifactControlAction);

  const seedPdfArtifactControlAction = React.useMemo<SofiaControlAction | null>(() => {
    if (!import.meta.env.DEV) return null;

    return {
      id: "eval.artifact_tabs.seed_pdf",
      label: "Seed a PDF artifact",
      description: "Write a small valid PDF and open it as an artifact tab to verify inline PDF rendering.",
      sideEffect: "mutation",
      disabled: !client || !workspaceId,
      execute: async () => {
        if (!client || !workspaceId) return { ok: false, error: "Workspace client is not ready." };

        // Minimal single-page PDF that draws "Sofia PDF" — base64 encoded.
        const pdfBase64 =
          "JVBERi0xLjQKMSAwIG9iago8PC9UeXBlL0NhdGFsb2cvUGFnZXMgMiAwIFI+PgplbmRvYmoKMiAwIG9iago8PC9UeXBlL1BhZ2VzL0tpZHNbMyAwIFJdL0NvdW50IDE+PgplbmRvYmoKMyAwIG9iago8PC9UeXBlL1BhZ2UvUGFyZW50IDIgMCBSL01lZGlhQm94WzAgMCAzMDAgMTQ0XS9SZXNvdXJjZXM8PC9Gb250PDwvRjEgNCAwIFI+Pj4+L0NvbnRlbnRzIDUgMCBSPj4KZW5kb2JqCjQgMCBvYmoKPDwvVHlwZS9Gb250L1N1YnR5cGUvVHlwZTEvQmFzZUZvbnQvSGVsdmV0aWNhPj4KZW5kb2JqCjUgMCBvYmoKPDwvTGVuZ3RoIDQ0Pj4Kc3RyZWFtCkJUCi9GMSAyNCBUZgo3MiA3MCBUZAooT3BlbldvcmsgUERGKSBUagpFVAplbmRzdHJlYW0KZW5kb2JqCnhyZWYKMCA2CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAwOSAwMDAwMCBuIAowMDAwMDAwMDU4IDAwMDAwIG4gCjAwMDAwMDAxMTUgMDAwMDAgbiAKMDAwMDAwMDI0MSAwMDAwMCBuIAowMDAwMDAwMzEyIDAwMDAwIG4gCnRyYWlsZXIKPDwvU2l6ZSA2L1Jvb3QgMSAwIFI+PgpzdGFydHhyZWYKNDA2CiUlRU9G";
        const binary = atob(pdfBase64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);

        const value = "artifacts/sample-document.pdf";
        await client.writeWorkspaceBinaryFile(workspaceId, { path: value, data: bytes.buffer, baseUpdatedAt: null });

        const target: OpenTarget = {
          id: `file:${value}`,
          kind: "file",
          value,
          name: "sample-document.pdf",
          preview: "pdf",
          confidence: 100,
          reason: "eval",
          exists: true,
          size: bytes.length,
        };

        const store = usePanelTabStore.getState();
        store.syncTranscriptArtifacts(sessionId, [target]);
        store.openTab(sessionId, { id: target.id, type: "artifact", label: target.name, preview: target.preview });
        store.selectTab(sessionId, target.id);

        return { ok: true, activeTabId: target.id };
      },
    };
  }, [client, sessionId, workspaceId]);
  useControlAction(seedPdfArtifactControlAction);

  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.altKey || event.metaKey || event.key !== "Tab" || tabs.length < 2) {
        return;
      }

      const activeIndex = activeTab ? tabs.findIndex((tab) => tab.id === activeTab.id) : -1;
      if (activeIndex === -1) {
        return;
      }

      event.preventDefault();
      const offset = event.shiftKey ? -1 : 1;
      selectTab(tabs[(activeIndex + offset + tabs.length) % tabs.length].id);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activeTab, selectTab, tabs]);

  return (
    <TooltipProvider delay={1000}>
      <div
        className="flex h-full flex-col"
        onKeyDownCapture={(event) => {
          if (!handlePanelEscape(event.key, onClose)) return;
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        <div className="shrink-0 border-b border-border bg-dls-canvas">
          <div className="flex h-10 items-center gap-1 px-2 [&_svg]:size-4 [&_svg]:stroke-[1.5]">
            <div className="no-scrollbar min-w-0 flex-1 overflow-x-auto">
              <PanelTabList
                values={tabs.map((tab) => tab.id)}
                onReorder={reorderTabs}
              >
                {tabs.map((tab) => (
                  <SidePanelTab
                    key={tab.id}
                    tab={tab}
                    active={tab.id === activeTab?.id}
                    onSelect={selectTab}
                    onClose={closeTab}
                  />
                ))}
              </PanelTabList>
            </div>
            {onToggleExpand ? (
              <Button variant="ghost" size="icon-sm" aria-label={expanded ? "Restore panel" : "Expand panel"}
                className="order-2 text-muted-foreground" data-testid="side-panel-expand" onClick={onToggleExpand}>
                {expanded ? <Minimize2 /> : <Maximize2 />}
              </Button>
            ) : null}
            <Button variant="ghost" size="icon-sm" aria-label="Close panel" title="Close panel"
              className="order-4 text-muted-foreground" onClick={onClose}><X /></Button>
            {activeTab?.type === "browser" ? (
              <Button variant="ghost" size="icon-sm" aria-label="Peek browser" data-testid="browser-show-peek"
                className="order-3 text-muted-foreground"
                onClick={() => dispatchBrowserPresentation({ type: "user-show-peek" })}><PictureInPicture2 /></Button>
            ) : null}
            {!activeTab ? <span className="sr-only">Panel destinations</span> : null}
            {(
              <Tooltip>
                <TooltipTrigger
                  render={(
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => openPanelTab("start")}
                      aria-label="New tab"
                      data-testid="browser-new-tab"
                      className="order-1 text-muted-foreground"
                    >
                      <Plus />
                    </Button>
                  )}
                />
                <TooltipContent>New tab</TooltipContent>
              </Tooltip>
            )}
          </div>
        </div>
        {!activeTab || activeTab.type === "start" ? (
          <PanelEmpty
            onOpenBrowser={isBrowserAvailable ? () => void openBrowserPage() : undefined}
            onNavigate={isBrowserAvailable ? (url) => void openBrowserPage(url) : undefined}
            recentPages={tabs.filter((tab) => tab.type === "browser").map((tab) => ({ id: tab.id, label: tab.label, url: tab.url }))}
            onSelectRecent={selectTab}
            onOpenFiles={() => openPanelTab("files")}
            onOpenExtensions={onOpenExtensions}
            onOpenVoice={onOpenVoice}
          />
        ) : null}
        {activeTab?.type === "files" ? (
          <WorkspaceFiles key={activeTab.id} client={client} workspaceId={workspaceId} workspaceRoot={workspaceRoot} remote={isRemoteWorkspace} initialPath={activeTab.path} onSelectPath={(path) => usePanelTabStore.getState().openTab(sessionId, { ...activeTab, path, label: path.split("/").pop() ?? path })} />
        ) : activeTab?.type === "browser" ? (
          <BrowserView sessionId={sessionId} tab={activeTab} onClose={onClose} />
        ) : activeTab?.type === "changes" ? (
          <ChangesPanel
            sessionId={sessionId}
            changeSetId={activeTab.changeSetId}
            filePath={activeTab.filePath}
            onOpenFile={(path) => openPanelTab("files", path)}
          />
        ) : activeTab?.type === "artifact" ? (
          <div className="min-h-0 flex-1 overflow-hidden">
            <ArtifactPanel
              sessionId={sessionId}
              tab={activeTab}
              client={client}
              workspaceId={workspaceId}
              workspaceRoot={workspaceRoot}
              isRemoteWorkspace={isRemoteWorkspace}
              onClose={onClose}
            />
          </div>
        ) : null}
      </div>
    </TooltipProvider>
  );
}
