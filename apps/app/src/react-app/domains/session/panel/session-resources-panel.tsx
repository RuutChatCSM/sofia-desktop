import { useMemo } from "react";
import { deriveRecordedSubagents, deriveCodexSubagents, mergeSessionSubagents } from "./session-subagents";
import { SessionSubagentsSection } from "./session-subagents-section";
import { isCollectibleArtifactTarget, isOpenableFileTarget, targetFromFile } from "../artifacts/open-target";
import { FileText, Globe, Link, Terminal, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePanelTabStore } from "./panel-tab-store";
import { useSessionResourcesStore } from "./session-resources-store";
import { EMPTY_SESSION_RESOURCES, type SessionSource } from "./session-resources";
import { useCodexSessionStore } from "../codex-session-store";

export function SessionResourcesPanel({sessionId,onOpenFile,onOpenUrl,onReveal,fullSources=false,fullOutputs=false}:{sessionId:string;onOpenFile:(path:string)=>void;onOpenUrl:(url:string)=>void;onReveal?:()=>void;fullSources?:boolean;fullOutputs?:boolean}) {
  const resources=useSessionResourcesStore(state=>state.sessions[sessionId] ?? EMPTY_SESSION_RESOURCES);
  const items=useCodexSessionStore(state=>state.sessions[sessionId]?.items);
  const children=useCodexSessionStore(state=>state.sessions[sessionId]?.subagentSessions);
  const subagents=useMemo(()=>mergeSessionSubagents(mergeSessionSubagents(resources.subagents,deriveRecordedSubagents(children ?? [])),deriveCodexSubagents(items ?? [])),[resources.subagents,items,children]);
  const processes=useCodexSessionStore(state=>state.sessions[sessionId]?.backgroundProcesses);
  const inlineImage=(source:SessionSource)=>source.mediaType?.startsWith("image/") && (source.value?.startsWith("data:image/") || source.value?.startsWith("blob:"));
  const request=(action:'create'|'attach')=>window.dispatchEvent(new CustomEvent('sofia:session-resources:action',{detail:{sessionId,action}}));
  const verified=usePanelTabStore(state=>state.transcriptArtifactTargets[sessionId]);
  const fileTarget=(source:SessionSource)=>{
    const targets=verified ?? [];
    const exact=targets.find(target=>isOpenableFileTarget(target) && (target.value===source.value || target.id===targetFromFile(source.value ?? "",95,"source")?.id));
    if(exact)return exact;
    // Artifact resolution can return a workspace-relative path. Reject ambiguous suffixes.
    const matches=targets.filter(target=>isOpenableFileTarget(target) && !target.value.startsWith("/") && source.value?.endsWith(`/${target.value}`));
    return matches.length===1?matches[0]:undefined;
  };
  const sourceAvailable=(source:SessionSource)=>{
    if(inlineImage(source))return true;
    if(!source.value)return false;
    if(source.kind==='url')return true;
    return Boolean(fileTarget(source));
  };
  const openSource=(source:SessionSource)=>{
    if (!source.value)return;
    if(inlineImage(source)){
      const store=usePanelTabStore.getState();
      const id=`source-image:${source.id}`;
      store.openTab(sessionId,{id,type:'source-image',label:source.label,src:source.value});
      store.selectTab(sessionId,id);onReveal?.();return;
    }
    if(source.kind==='url')onOpenUrl(source.value);
    else if(source.kind==='file'&&!/^(data:|blob:)/.test(source.value)) {
      const store=usePanelTabStore.getState();
      const target=fileTarget(source);
      if(!target || !isOpenableFileTarget(target))return;
      store.openTab(sessionId,{id:target.id,type:'artifact',label:source.label,preview:target.preview});store.selectTab(sessionId,target.id);onReveal?.();
    }
  };
  return <section data-computer-preview-obstacle data-session-resources="" className="session-resources-card m-5 flex flex-col rounded-2xl border p-5">
    {!fullSources ? <div><div className="mb-2 flex items-center justify-between"><h2 className="text-muted-foreground">Outputs</h2><Button size="icon-sm" variant="ghost" aria-label="Create an output" onClick={()=>request('create')}><Plus className="size-[18px]" /></Button></div>
      {resources.outputs.length===0?<button className="text-muted-foreground/70 hover:text-foreground" onClick={()=>request('create')}>Create a file or site</button>:(fullOutputs?resources.outputs:resources.outputs.slice(0,3)).map(artifact=><button key={artifact.id} disabled={!isCollectibleArtifactTarget(artifact.legacy_target)} title={artifact.legacy_target.exists===false?"File unavailable":artifact.path} data-resource-output="" className="flex w-full items-center gap-2 rounded-md py-1.5 text-left hover:bg-muted" onClick={()=>{
        const store=usePanelTabStore.getState();const existing=store.transcriptArtifactTargets[sessionId] ?? [];
        store.syncTranscriptArtifacts(sessionId,[...existing.filter(target=>target.id!==artifact.legacy_target.id),artifact.legacy_target]);
        store.openTab(sessionId,{id:artifact.legacy_target.id,type:'artifact',label:artifact.name,preview:artifact.legacy_target.preview});
        store.selectTab(sessionId,artifact.legacy_target.id);onReveal?.();
      }}><FileText className="size-4 shrink-0" /><span className="truncate">{artifact.name}</span></button>)}
      {!fullOutputs && resources.outputs.length>3?<button aria-label="View all outputs" className="mt-2 flex items-center gap-2 text-muted-foreground hover:text-foreground" onClick={()=>{
        const store=usePanelTabStore.getState();const id=`outputs:${sessionId}`;
        store.openTab(sessionId,{id,type:'outputs',label:'Outputs'});store.selectTab(sessionId,id);onReveal?.();
      }}><FileText className="size-4"/>View all</button>:null}
    </div>:null}
    {!fullSources && !fullOutputs ? <SessionSubagentsSection agents={subagents} onOpen={()=>{
      const store=usePanelTabStore.getState();const id=`subagents:${sessionId}`;
      store.openTab(sessionId,{id,type:'subagents',label:'Subagents'});store.selectTab(sessionId,id);onReveal?.();
    }}/> : null}
    {!fullSources && !fullOutputs && processes?.length?<div className="border-t border-border pt-3"><h3 className="mb-2 text-muted-foreground">Background processes</h3>{processes.map(process=><div key={process.processId} title={process.command} className="flex items-center gap-2 py-1"><Terminal className="size-4 shrink-0"/><span className="min-w-0 flex-1 truncate">{process.title || process.command}</span><span className="text-xs text-muted-foreground">{process.status}</span></div>)}</div>:null}
    {!fullOutputs ? <div className="border-t border-border pt-3"><div className="mb-2 flex items-center justify-between"><h2 className="text-muted-foreground">Sources</h2><Button size="icon-sm" variant="ghost" aria-label="Attach source files" onClick={()=>request('attach')}><Plus className="size-[18px]" /></Button></div>
      {resources.sources.length===0?<p className="text-muted-foreground/70">No sources yet</p>:(fullSources?resources.sources:resources.sources.slice(0,3)).map(source=><button key={source.id} data-resource-source="" title={source.value && !/^(data:|blob:)/.test(source.value) ? source.value : source.label} disabled={!sourceAvailable(source)} onClick={()=>openSource(source)} className="flex w-full items-center gap-2 rounded-md py-1.5 text-left hover:bg-muted disabled:cursor-default disabled:hover:bg-transparent">
        {inlineImage(source)?<img src={source.value} alt="" className="size-[18px] shrink-0 rounded-[3px] border border-border object-cover"/>:(source.kind==='url'||source.kind==='web')?<Globe className="size-4 shrink-0"/>:source.kind==='tool'?<Link className="size-4 shrink-0"/>:<FileText className="size-4 shrink-0"/>}<span className="truncate">{source.label}</span>
      </button>)}
      {!fullSources && resources.sources.length>0?<button aria-label="View all sources" className="mt-2 flex items-center gap-2 text-muted-foreground hover:text-foreground" onClick={()=>{
        const store=usePanelTabStore.getState();const id=`sources:${sessionId}`;
        store.openTab(sessionId,{id,type:'sources',label:'Sources'});store.selectTab(sessionId,id);onReveal?.();
      }}><Link className="size-4"/>View all</button>:null}
    </div>:null}

  </section>;
}
