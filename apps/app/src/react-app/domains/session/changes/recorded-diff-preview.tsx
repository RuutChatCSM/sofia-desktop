import { useEffect, useMemo, useState } from "react";
import { highlightCode, type HighlightedLine } from "./diff-highlight";

export function recordedDiffLines(patch: string) {
  let oldLine: number | undefined;
  let newLine: number | undefined;
  return patch.split(/\r?\n/).flatMap(line => {
    if (line.startsWith("*** ") || line.startsWith("diff --git ") || line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ ") || !line) return [];
    if (line.startsWith("@@")) {
      const coordinates = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
      oldLine = coordinates ? Number(coordinates[1]) : undefined;
      newLine = coordinates ? Number(coordinates[2]) : undefined;
      return [{kind:"hunk",text:line,oldLine:undefined,newLine:undefined}];
    }
    const kind = line.startsWith("+") ? "add" : line.startsWith("-") ? "delete" : "context";
    const row = {kind,text:line.slice(1),oldLine:kind === "add" ? undefined : oldLine,newLine:kind === "delete" ? undefined : newLine};
    if (kind !== "add" && oldLine !== undefined) oldLine++;
    if (kind !== "delete" && newLine !== undefined) newLine++;
    return [row];
  });
}

export function RecordedDiffPreview({patch,path,additions,deletions}:{patch:string;path:string;additions:number;deletions:number}) {
  const rows=useMemo(()=>recordedDiffLines(patch),[patch]);
  const [tokens,setTokens]=useState<HighlightedLine[]>([]);
  useEffect(()=>{let cancelled=false;void highlightCode(rows.map(row=>row.text).join("\n"),path).then(value=>{if(!cancelled)setTokens(value);});return()=>{cancelled=true;};},[rows,path]);
  return <>
    <div className="flex h-9 items-center gap-2 border-b border-border bg-muted/50 px-4 text-xs"><span className="min-w-0 flex-1 truncate">{path}</span><span className="text-emerald-11">+{additions}</span><span className="text-red-11">−{deletions}</span></div>
    <div data-recorded-patch="" className="max-h-96 overflow-auto font-mono text-xs leading-5">
      {rows.map((row,index)=><div key={index} className={`flex min-w-max ${row.kind==="add"?"bg-emerald-500/10":row.kind==="delete"?"bg-red-500/10":row.kind==="hunk"?"bg-muted/40 text-muted-foreground":""}`}>
        <span className="sticky left-0 w-9 shrink-0 select-none bg-popover/80 pr-2 text-right text-muted-foreground/50">{row.oldLine}</span><span className="sticky left-9 w-9 shrink-0 select-none bg-popover/80 pr-2 text-right text-muted-foreground/50">{row.newLine}</span><span className="w-5 shrink-0 text-center text-muted-foreground">{row.kind==="add"?"+":row.kind==="delete"?"−":""}</span>
        <span className="whitespace-pre pr-4">{tokens[index]?.map((token,position)=><span key={position} style={{color:token.color}}>{token.text}</span>) ?? row.text}</span>
      </div>)}
    </div>
  </>;
}
