import { useState } from "react";
import { Check, ChevronDown, Folder, Monitor, Search } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { NewTaskComposerContext } from "./new-task-composer";

export function ProjectComposerStrip({ context, docked = false }: { context: NewTaskComposerContext; docked?: boolean }) {
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [projectQuery, setProjectQuery] = useState("");
  if (!context.projects?.length || !context.onSelectProject) return null;
  const strip = (
<div data-project-composer-strip className="flex items-center gap-3 rounded-t-xl bg-dls-hover mx-2 px-2 pt-1 pb-5 -mb-4 text-xs text-dls-secondary">
          <Popover open={projectPickerOpen} onOpenChange={setProjectPickerOpen}>
            <PopoverTrigger className="flex min-w-0 items-center gap-2 rounded-lg px-2 py-1 hover:bg-dls-hover" aria-label="Choose project">
              <Folder className="size-3.5 shrink-0" /><span className="truncate">{context.projects!.find((project) => project.id === context.workspaceId)?.name ?? "Choose project"}</span><ChevronDown className="size-3" />
            </PopoverTrigger>
            <PopoverContent align="start" side="top" className="gap-1 rounded-2xl p-2">
              <label className="flex items-center gap-2 border-b border-dls-border px-2 py-2"><Search className="size-4" /><input aria-label="Search projects" placeholder="Search projects" value={projectQuery} onChange={(event) => setProjectQuery(event.target.value)} className="w-full bg-transparent outline-none" /></label>
              <div className="max-h-64 overflow-y-auto">
                {context.projects!.filter((project) => `${project.name} ${project.path}`.toLowerCase().includes(projectQuery.toLowerCase())).map((project) => (
                  <button key={project.id} type="button" title={project.path} aria-pressed={project.id === context.workspaceId} className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left hover:bg-dls-hover" onClick={() => { context.onSelectProject?.(project.id); setProjectPickerOpen(false); setProjectQuery(""); }}><Folder className="size-4 shrink-0" /><span className="flex-1 truncate">{project.name}</span>{project.id === context.workspaceId ? <Check className="size-4" /> : null}</button>
                ))}
                {!context.projects!.some((project) => `${project.name} ${project.path}`.toLowerCase().includes(projectQuery.toLowerCase())) ? <p className="px-2 py-3 text-dls-secondary">No projects found</p> : null}
              </div>
            </PopoverContent>
          </Popover>
          <span className="flex items-center gap-2"><Monitor className="size-3.5" />{context.isRemoteWorkspace ? "Remote workspace" : "This computer"}</span>
        </div>
  );
  return docked ? <div className="max-lg:px-3 lg:px-8"><div className="mx-auto w-full max-w-[800px]">{strip}</div></div> : strip;
}
