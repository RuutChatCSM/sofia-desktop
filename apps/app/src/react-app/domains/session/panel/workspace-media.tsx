/** @jsxImportSource react */
import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import type { SofiaServerClient } from "@/app/lib/sofia-server";

export function mediaType(path: string) {
  if (/\.(png|jpe?g|gif|webp|svg|ico|bmp|avif)$/i.test(path)) return "image";
  if (/\.(mp3|wav|ogg|m4a|aac|flac|opus)$/i.test(path)) return "audio";
  if (/\.(mp4|webm|mov|m4v|ogv)$/i.test(path)) return "video";
  if (/\.pdf$/i.test(path)) return "pdf";
  return null;
}

export function WorkspaceMedia({ client, workspaceId, path }: { client: SofiaServerClient | null; workspaceId: string | null; path: string }) {
  const kind = mediaType(path);
  const [url, setUrl] = React.useState("");
  const [failed, setFailed] = React.useState(false);
  const [scale, setScale] = React.useState("fit");
  const data = useQuery({ queryKey: ["workspace-media", workspaceId, path], enabled: Boolean(client && workspaceId),
    queryFn: async () => client && workspaceId ? client.downloadWorkspaceFile(workspaceId, path) : null,
    gcTime: 0, refetchOnWindowFocus: false });
  React.useEffect(() => {
    setFailed(false); setUrl("");
    if (!data.data) return;
    const objectUrl = URL.createObjectURL(new Blob([data.data.data], { type: data.data.contentType ?? "application/octet-stream" }));
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [data.data]);
  if (data.isError) return <p role="alert" className="p-4 text-sm">{data.error.message}</p>;
  if (!url) return <p className="p-4 text-sm text-muted-foreground">Loading preview…</p>;
  return <div data-testid="workspace-media-preview" className="flex h-full min-h-0 flex-col">
    <div className="flex shrink-0 items-center justify-end gap-2 px-4 py-2 text-xs text-muted-foreground">
      {kind === "image" ? <select aria-label="Image zoom" className="rounded-md bg-muted px-2 py-1" value={scale} onChange={(event) => setScale(event.target.value)}><option value="fit">Fit</option><option value="actual">100%</option><option value="2">200%</option></select> : null}
      <Button size="sm" variant="ghost" render={<a href={url} download={path.split("/").pop()}>Download</a>} />
    </div>
    {failed ? <p role="alert" className="p-4 text-sm">This media format cannot be displayed here. Download it or open it in an application.</p> : null}
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
      {kind === "image" ? <img src={url} alt={path.split("/").pop()} onError={() => setFailed(true)} className={scale === "fit" ? "max-h-full max-w-full object-contain" : "max-w-none shrink-0"} style={scale === "2" ? { zoom: 2 } : undefined} />
        : kind === "audio" ? <audio src={url} controls preload="metadata" onError={() => setFailed(true)} className="w-full max-w-lg" />
        : kind === "video" ? <video src={url} controls preload="metadata" onError={() => setFailed(true)} className="max-h-full max-w-full" />
        : <iframe title={path.split("/").pop()} src={url} className="h-full w-full border-0" />}
    </div>
  </div>;
}
