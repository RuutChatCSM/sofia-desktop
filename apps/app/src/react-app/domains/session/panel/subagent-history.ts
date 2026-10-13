export type SubagentHistoryItem = { turnId: string; item: Record<string, unknown> };
export type SubagentHistoryEntry = { id: string; label: string; text: string };

/** Display recorded content only; hidden reasoning is never synthesized. */
export function projectSubagentHistory(items: readonly SubagentHistoryItem[]): SubagentHistoryEntry[] {
  return items.map(({ item }, index) => {
    const type = typeof item.type === "string" ? item.type : "Activity";
    let text = typeof item.text === "string" ? item.text : typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : "";
    if (Array.isArray(item.content)) text = item.content.flatMap(part => typeof part === "object" && part !== null && "text" in part && typeof part.text === "string" ? [part.text] : []).join("\n");
    if (!text && typeof item.command === "string") text = item.command;
    return { id: typeof item.id === "string" ? item.id : `${type}-${index}`, label: type === "userMessage" ? "User" : type === "agentMessage" ? "Assistant" : type === "reasoning" ? "Recorded thinking" : type === "commandExecution" ? "Ran command" : type === "fileChange" ? "Changed files" : type === "mcpToolCall" ? "Used tool" : "Activity", text };
  }).filter(entry => entry.text.length > 0);
}

import type { UIMessage } from "ai";
import { codexItemToToolParts } from "../sync/codex-item-translator";
import { stripInjectedCodexContext } from "../sync/codex-context-fragments";
import { normalizeUserMessageDisplayParts } from "../sync/user-message-display";

/** Same canonical tool parts and turn metadata used by the main transcript. */
export function subagentHistoryMessages(items: readonly SubagentHistoryItem[], sessionId: string): UIMessage[] {
  return items.flatMap(({item,turnId},index): UIMessage[] => {
    const id=typeof item.id === "string" ? item.id : `subagent-${index}`;
    let parts: UIMessage["parts"] = [];
    if(item.type === "userMessage") {
      const content=Array.isArray(item.content)?item.content:[];
      const text=stripInjectedCodexContext(content.flatMap(part=>typeof part === "object" && part !== null && "text" in part && typeof part.text === "string"?[part.text]:[]).join("\n"));
      if(text)parts.push({type:"text",text});
      for(const part of content)if(typeof part === "object" && part !== null && "type" in part && part.type === "image" && "url" in part && typeof part.url === "string")parts.push({type:"file",url:part.url,mediaType:"image/png"});
      parts=normalizeUserMessageDisplayParts(parts);
    } else if(item.type === "agentMessage" && typeof item.text === "string")parts=[{type:"text",text:item.text}];
    else if(item.type === "reasoning") {
      const values=Array.isArray(item.summary)?item.summary:item.content;
      const text=Array.isArray(values)?values.flatMap(value=>typeof value === "string"?[value]:typeof value === "object" && value !== null && "text" in value && typeof value.text === "string"?[value.text]:[]).join("\n"):"";
      if(text)parts=[{type:"reasoning",text,state:"done"}];
    } else {
      parts=codexItemToToolParts(item,sessionId,id,true);
    }
    if(!parts.length)return [];
    return [{id,role:item.type === "userMessage"?"user":"assistant",parts,metadata:{engine:{turnId,...(typeof item.phase === "string"?{phase:item.phase}:{}),...(typeof item.turnStartedAt === "number"?{turnStartedAt:item.turnStartedAt}:{}),...(typeof item.turnCompletedAt === "number"?{turnCompletedAt:item.turnCompletedAt}:{})}}}];
  });
}
