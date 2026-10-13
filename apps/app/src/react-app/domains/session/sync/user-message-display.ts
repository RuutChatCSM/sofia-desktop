import type { UIMessage } from "ai";

/** Hide the desktop transport envelope in presentation only, retaining model history. */
export function normalizeUserMessageDisplayParts(parts: UIMessage["parts"]): UIMessage["parts"] {
  let names: string[] = [];
  const normalized=parts.map(part=>{
    if(part.type!=="text" || !/^\s*# Files mentioned by the user:\s*\n/.test(part.text))return part;
    const request=part.text.match(/^## My request:\s*\n/m);
    if(!request || request.index===undefined)return part;
    const prefix=part.text.slice(0,request.index);
    names=Array.from(prefix.matchAll(/^## (.+): \/[^\n]+$/gm),match=>match[1]);
    const paths=new Set(Array.from(prefix.matchAll(/^## .+: (\/[^\n]+)$/gm),match=>match[1]));
    const text=part.text.slice(request.index+request[0].length)
      .replace(/<image\s+name=(?:"\[Image #\d+\]"|\[Image #\d+\])\s+path="([^"]+)"\s*>\s*<\/image>/g,(tag,path:string)=>paths.has(path)?"":tag)
      .trim();
    return {...part,text};
  });
  const files=normalized.filter(part=>part.type==="file");
  if(names.length!==files.length)return normalized;
  let index=0;
  return normalized.map(part=>{
    if(part.type!=="file")return part;
    const filename=names[index++];
    return {...part,filename:part.filename || filename};
  });
}
