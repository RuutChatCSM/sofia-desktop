import { deriveSessionSubagents, type SessionSubagent } from "./session-subagents";
import type { UIMessage } from "ai";
import { getArtifactsFromMessages, type ArtifactItem } from "@/lib/artifacts";
import { isReadToolPart, isEditToolPart, isApplyPatchToolPart } from "@/lib/build-in-tools";
import type { OpenTarget } from "../artifacts/open-target";
import { filePathFromFileUrl } from "../artifacts/open-target";

export type SessionSource = { id: string; kind: "file" | "url" | "document" | "tool" | "web"; label: string; value?: string; mediaType?: string };
export type SessionResources = { outputs: ArtifactItem[]; sources: SessionSource[]; subagents: SessionSubagent[] };
export const EMPTY_SESSION_RESOURCES: SessionResources = { outputs: [], sources: [], subagents: [] };

function httpUrl(value: string): string | null {
  try { const url = new URL(value); return url.protocol === "http:" || url.protocol === "https:" ? url.href : null; } catch { return null; }
}

/** Project recorded input/reference facts separately from produced artifacts. */
export function deriveSessionResources(messages: readonly UIMessage[], verifiedTargets: OpenTarget[] = []): SessionResources {
  const sources = new Map<string, SessionSource>();
  const outputs: UIMessage[] = [];
  const add = (source: SessionSource) => { if (!sources.has(source.id)) sources.set(source.id, source); };
  for (const message of [...messages].reverse()) {
    const produced: UIMessage["parts"] = [];
    for (const part of message.parts) {
      if (part.type === "dynamic-tool") {
        const metadata = part.callProviderMetadata?.engine;
        if (metadata && typeof metadata === "object" && "codexItemType" in metadata && metadata.codexItemType === "webSearch") {
          add({id:"web-search",kind:"web",label:"Web search"});
        }
        if (metadata && typeof metadata === "object" && "codexItemType" in metadata && metadata.codexItemType === "mcpToolCall") {
          const server = "codexToolServer" in metadata && typeof metadata.codexToolServer === "string" ? metadata.codexToolServer : "";
          const name = "codexToolName" in metadata && typeof metadata.codexToolName === "string" ? metadata.codexToolName : part.toolName;
          add({id:`tool:${server || name}`,kind:"tool",label:server || name});
        }
      }
      if (part.type === "file" && message.role === "user") {
        const path = filePathFromFileUrl(part.url);
        add({id:`file:${path ?? part.url}`,kind:"file",label:part.filename || "Attached file",value:path ?? part.url,mediaType:part.mediaType});
      } else if (part.type === "source-url") {
        const url = httpUrl(part.url);
        if (url) add({id:`url:${url}`,kind:"url",label:part.title || new URL(url).hostname,value:url});
      } else if (part.type === "source-document") {
        add({id:`document:${part.sourceId}`,kind:"document",label:part.title,mediaType:part.mediaType});
      } else {
        if (message.role === "assistant" && !(part.type === "dynamic-tool" && (isReadToolPart(part) || isEditToolPart(part) || isApplyPatchToolPart(part)))) produced.push(part);
      }
    }
    if (produced.length) outputs.unshift({...message,parts:produced});
  }
  const priority: Record<SessionSource["kind"],number>={file:0,url:1,document:1,tool:2,web:3};
  return {subagents:deriveSessionSubagents(messages),outputs:getArtifactsFromMessages(outputs,verifiedTargets,{includeTargetFallbacks:false}).filter(artifact=>! /\.(?:[cm]?[jt]sx?|py|rb|go|rs|java|kt|swift|php|[ch](?:pp)?|cs|sql|sh|bash|zsh|css|scss|vue|svelte|jsonc?|ya?ml|toml)$/i.test(artifact.path)),sources:[...sources.values()].sort((left,right)=>priority[left.kind]-priority[right.kind])};
}
