import { useState } from "react";
import { Download, ImageIcon, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Image sources occupy the existing docked tab surface, not a dialog. */
export function SourceImagePanel({ src, label, onOpenExternal }: { src: string; label: string; onOpenExternal?: () => void }) {
  const [zoom, setZoom] = useState("fit");
  const [failed, setFailed] = useState(false);
  return <div data-source-image-panel="" className="flex h-full min-h-0 flex-col bg-dls-canvas">
    <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3 text-sm text-muted-foreground">
      <ImageIcon className="size-4"/><span className="flex-1">Image</span>
      <select aria-label="Image zoom" value={zoom} onChange={event=>setZoom(event.target.value)} className="rounded-md bg-muted px-2 py-1">
        <option value="fit">Fit</option>{[25,50,75,100,150,200].map(value=><option key={value} value={value}>{value}%</option>)}
      </select>
      {onOpenExternal?<Button variant="ghost" size="sm" onClick={onOpenExternal} aria-label="Open externally"><ExternalLink className="size-4"/>Open</Button>:null}
      <Button variant="ghost" size="icon-sm" aria-label="Download image" onClick={()=>{const anchor=document.createElement("a");anchor.href=src;anchor.download=label;anchor.click();}}><Download/></Button>
    </div>
    <div className="flex min-h-0 flex-1 overflow-auto p-4">
      {failed?<p role="alert" className="m-auto text-sm text-muted-foreground">This image could not be loaded.</p>:<img src={src} alt={label} onError={()=>setFailed(true)} className={zoom==="fit"?"m-auto max-h-full max-w-full object-contain":"m-auto max-w-none shrink-0"} style={zoom==="fit"?undefined:{zoom:Number(zoom)/100}}/>}
    </div>
  </div>;
}
