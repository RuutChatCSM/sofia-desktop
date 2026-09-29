/** @jsxImportSource react */
import * as React from "react";
import { useQuery, useQueries, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Folder, FolderOpen, RefreshCw, Search, ChevronDown, MoreHorizontal, ExternalLink } from "lucide-react";
import type { SofiaServerClient } from "@/app/lib/sofia-server";
import { openDesktopPath, getDesktopApplicationsForFile, openDesktopWithApp } from "@/app/lib/desktop";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { MarkdownPreview } from "../artifacts/preview";
import { mediaType, WorkspaceMedia } from "./workspace-media";
import { FileTypeIcon } from "./file-type-icon";
import { ArtifactTextEditor } from "../artifacts/artifact-text-editor";

// Keep unsaved edits when users switch panel tabs. The server still checks the
// original timestamp when saving, so newer external edits are never overwritten.
const drafts = new Map<string, { content: string; baseUpdatedAt: number | null }>();

export function WorkspaceFiles({ client, workspaceId, workspaceRoot, remote, initialPath, onSelectPath }: {
  client: SofiaServerClient | null; workspaceId: string | null; workspaceRoot: string; remote: boolean; initialPath?: string; onSelectPath?: (path: string) => void;
}) {
  const queryClient = useQueryClient();
  const [path, setPath] = React.useState(initialPath ?? "");
  const [source, setSource] = React.useState(false);
  const media = mediaType(path);
  const markdown = /\.(md|mdx|markdown)$/i.test(path);
  React.useEffect(() => { if (initialPath) setPath(initialPath); }, [initialPath]);
  const [filter, setFilter] = React.useState("");
  const [expanded, setExpanded] = React.useState(new Set<string>());
  const [treeVisible, setTreeVisible] = React.useState(true);
  const [draft, setDraft] = React.useState("");
  const [preferredEditor, setPreferredEditor] = React.useState(() => localStorage.getItem("sofia:preferred-editor") ?? "");
  const externalPath = `${workspaceRoot.replace(/\/$/, "")}/${path}`;
  const applications = useQuery({ queryKey: ["file-applications", externalPath], enabled: Boolean(path && !remote), queryFn: () => getDesktopApplicationsForFile(externalPath) });
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState("");
  const directories = useQueries({ queries: ["", ...expanded].map((directory) => ({
    queryKey: ["workspace-tree", workspaceId, directory], enabled: Boolean(client && workspaceId),
    queryFn: async () => client && workspaceId ? client.listWorkspaceEntries(workspaceId, directory) : [],
  })) });
  const entries = {
    data: directories.flatMap((directory) => directory.data ?? []),
    isLoading: directories.some((directory) => directory.isLoading),
    isError: directories.some((directory) => directory.isError),
    error: directories.find((directory) => directory.error)?.error,
    refetch: () => Promise.all(directories.map((directory) => directory.refetch())),
  };
  const file = useQuery({ queryKey: ["workspace-editor", workspaceId, path], enabled: Boolean(client && workspaceId && path && !media),
    queryFn: async () => client && workspaceId ? client.readWorkspaceFile(workspaceId, path) : null,
    refetchOnWindowFocus: false });
  const draftKey = `${workspaceId}:${path}`;
  React.useEffect(() => {
    setError("");
    setDraft(drafts.get(draftKey)?.content ?? file.data?.content ?? "");
  }, [draftKey, file.data]);
  const dirty = drafts.has(draftKey);
  React.useEffect(() => {
    setSource(false);
    const parts = path.split("/"); parts.pop();
    setExpanded((previous) => {
      const next = new Set(previous);
      parts.forEach((_part, index) => next.add(parts.slice(0, index + 1).join("/")));
      return next;
    });
  }, [path]);
  const metadata = markdown ? /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(draft) : null;
  const metadataRows = metadata?.[1]?.split("\n").map((line) => /^([^:#]+):\s*(.*)$/.exec(line));
  const document = metadata ? draft.slice(metadata[0].length) : draft;
  const selectedEditor = applications.data?.find((application) => application.appPath === preferredEditor) ?? applications.data?.find((application) => application.isDefault);

  const save = async () => {
    if (!client || !workspaceId || !file.data || saving) return;
    setSaving(true); setError("");
    try {
      const savedContent = draft;
      const result = await client.writeWorkspaceFile(workspaceId, { path, content: draft, baseUpdatedAt: drafts.get(draftKey)?.baseUpdatedAt ?? file.data.updatedAt ?? null });
      const latest = drafts.get(draftKey);
      if (latest && latest.content !== savedContent) drafts.set(draftKey, { ...latest, baseUpdatedAt: result.updatedAt });
      else drafts.delete(draftKey);
      await file.refetch();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save file."); }
    finally { setSaving(false); }
  };
  const openEditor = async () => {
    try { if (preferredEditor && selectedEditor?.appPath === preferredEditor) await openDesktopWithApp(externalPath, preferredEditor); else await openDesktopPath(externalPath); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not open editor."); }
  };
  const visible = (entries.data ?? []).filter((entry) => {
    if (filter) return entry.path.toLowerCase().includes(filter.toLowerCase());
    const parts = entry.path.split("/"); parts.pop();
    return parts.every((_part, index) => expanded.has(parts.slice(0, index + 1).join("/")));
  }).sort((a, b) => {
    const kinds = new Map(entries.data.map((entry) => [entry.path, entry.kind]));
    const left = a.path.split("/"); const right = b.path.split("/");
    for (let index = 0; index < Math.min(left.length, right.length); index++) {
      if (left[index] === right[index]) continue;
      const leftDir = kinds.get(left.slice(0, index + 1).join("/")) === "dir";
      const rightDir = kinds.get(right.slice(0, index + 1).join("/")) === "dir";
      if (leftDir !== rightDir) return leftDir ? -1 : 1;
      return (left[index] ?? "").localeCompare(right[index] ?? "");
    }
    return left.length - right.length;
  });
  return <div data-testid="workspace-files" className="flex min-h-0 flex-1 flex-col">
    <div className="flex min-h-11 shrink-0 items-center gap-1 border-b border-border px-3 text-xs [&_svg]:stroke-[1.5]">
      <nav aria-label="File breadcrumbs" className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden text-muted-foreground">
        <span className="shrink-0">{workspaceRoot.split("/").filter(Boolean).pop()}</span>
        {path.split("/").filter(Boolean).map((part, index, parts) => <React.Fragment key={index}><ChevronRight className="size-3 shrink-0" />{index === parts.length - 1 ? <span title={path} className="flex min-w-0 items-center gap-2 truncate font-medium text-foreground"><FileTypeIcon path={path} />{part}{dirty ? " •" : ""}</span> : <button type="button" className="truncate hover:text-foreground" onClick={() => setExpanded((previous) => new Set([...previous, parts.slice(0, index + 1).join("/")]))}>{part}</button>}</React.Fragment>)}
      </nav>
      {markdown ? <Button size="sm" variant="ghost" onClick={() => setSource(!source)}>{source ? "Preview" : "View source"}</Button> : null}
      {path && dirty ? <Button size="sm" variant="ghost" disabled={saving || !file.data} onClick={() => void save()}>{saving ? "Saving…" : "Save"}</Button> : null}
      <Button size="icon-sm" variant="ghost" aria-label="Toggle workspace tree" onClick={() => setTreeVisible(!treeVisible)}><FolderOpen /></Button>
      {path && !remote ? <div className="flex items-center rounded-lg border border-border">
        <Button size="sm" variant="ghost" title={selectedEditor ? `Open in ${selectedEditor.name}` : "Open in default application"} onClick={() => void openEditor()}>{selectedEditor?.icon ? <img src={selectedEditor.icon} alt="" className="size-4 shrink-0 object-contain" /> : <ExternalLink className="size-4" />}Open</Button>
        <DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Preferred editor"><ChevronDown /></Button>} /><DropdownMenuContent align="end"><DropdownMenuItem onClick={() => { setPreferredEditor(""); localStorage.removeItem("sofia:preferred-editor"); }}>Default application</DropdownMenuItem>{(applications.data ?? []).map((application) => <DropdownMenuItem key={application.appPath} onClick={() => { setPreferredEditor(application.appPath); localStorage.setItem("sofia:preferred-editor", application.appPath); }}>{application.icon ? <img src={application.icon} alt="" className="size-4 shrink-0 object-contain" /> : <ExternalLink className="size-4" />}{application.name}</DropdownMenuItem>)}</DropdownMenuContent></DropdownMenu>
      </div> : null}
      {path ? <DropdownMenu><DropdownMenuTrigger render={<Button size="icon-sm" variant="ghost" aria-label="File actions"><MoreHorizontal /></Button>} /><DropdownMenuContent align="end"><DropdownMenuItem disabled={saving} onClick={() => { drafts.delete(draftKey); setDraft(file.data?.content ?? ""); setError(""); if (media) void queryClient.invalidateQueries({ queryKey: ["workspace-media", workspaceId, path] }); else void file.refetch(); }}>Reload from disk</DropdownMenuItem></DropdownMenuContent></DropdownMenu> : null}
    </div>
    {error ? <p role="alert" className="px-3 py-2 text-xs text-destructive">{error}</p> : null}
    <div className="flex min-h-0 flex-1">
      <div className="min-w-0 flex-1 overflow-hidden" onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "s") { event.preventDefault(); void save(); } }}>
        {!path ? <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground"><FolderOpen /><span>Open file</span><span>Select a file from the workspace tree</span></div>
          : media ? <WorkspaceMedia key={draftKey} client={client} workspaceId={workspaceId} path={path} />
          : file.isError ? <p role="alert" className="p-4 text-sm">{file.error.message}</p>
          : file.isLoading ? <p className="p-4 text-sm text-muted-foreground">Reading file…</p>
          : file.data && markdown && !source ? <div data-testid="workspace-document-preview" className="h-full overflow-auto px-6 py-5">
            {metadata ? <section aria-label="Document metadata" className="mb-6 rounded-lg border border-border bg-muted/30 p-4"><h2 className="mb-2 text-xs text-muted-foreground">Metadata</h2>{metadataRows?.every((row) => row !== null) ? <dl className="grid grid-cols-[minmax(5rem,1fr)_3fr] gap-x-6 gap-y-2 font-mono text-xs leading-6">{metadataRows.map((row, index) => row ? <React.Fragment key={index}><dt className="text-muted-foreground">{row[1]}</dt><dd className="whitespace-pre-wrap break-words">{row[2]}</dd></React.Fragment> : null)}</dl> : <pre className="whitespace-pre-wrap font-mono text-xs leading-6">{metadata[1]}</pre>}</section> : null}
            <MarkdownPreview content={document} className="h-auto overflow-visible p-0" />
          </div>
          : file.data ? <ArtifactTextEditor key={draftKey} className="h-full" value={draft} language="text" filePath={path} onChange={(content) => { setDraft(content); drafts.set(draftKey, { content, baseUpdatedAt: drafts.get(draftKey)?.baseUpdatedAt ?? file.data?.updatedAt ?? null }); }} /> : null}
      </div>
      {treeVisible ? <aside className="flex w-64 max-w-[40%] shrink-0 flex-col border-l border-border" aria-label="Workspace files">
        <div className="flex items-center gap-1 p-2"><Search className="ml-1 size-3.5 shrink-0 text-muted-foreground" /><input aria-label="Filter workspace files" placeholder="Filter files…" className="min-w-0 flex-1 rounded-md border border-border bg-transparent px-2 py-1 text-xs" value={filter} onChange={(event) => setFilter(event.target.value)} /><Button variant="ghost" size="icon-sm" aria-label="Refresh files" onClick={() => void entries.refetch()}><RefreshCw /></Button></div>
        <div className="min-h-0 flex-1 overflow-auto">
          {entries.isLoading ? <p className="p-3 text-xs">Loading files…</p> : null}
          {entries.isError ? <p role="alert" className="p-3 text-xs">{entries.error?.message}</p> : null}
          {visible.map((entry) => <button key={entry.path} title={entry.path} data-workspace-file={entry.path} aria-expanded={entry.kind === "dir" ? expanded.has(entry.path) : undefined} className={`flex w-full items-center gap-2 py-1.5 pr-2 text-left text-xs hover:bg-muted ${path === entry.path ? "bg-muted" : ""}`} style={{ paddingLeft: filter ? 12 : 12 + (entry.path.split("/").length - 1) * 12 }} onClick={() => {
            if (entry.kind === "file") { setPath(entry.path); onSelectPath?.(entry.path); }
            else setExpanded((previous) => { const next = new Set(previous); if (next.has(entry.path)) next.delete(entry.path); else next.add(entry.path); return next; });
          }}>{entry.kind === "dir" ? <><ChevronRight className={`size-3 shrink-0 ${expanded.has(entry.path) ? "rotate-90" : ""}`} /><Folder className="size-3.5 shrink-0" /></> : <><span className="w-3 shrink-0" /><FileTypeIcon path={entry.path} /></>}<span className="truncate">{filter ? entry.path : entry.path.split("/").pop()}</span></button>)}
        </div>
      </aside> : null}
    </div>
  </div>;
}
