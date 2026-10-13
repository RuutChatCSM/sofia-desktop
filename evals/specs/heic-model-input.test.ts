import { expect, vi, onTestFinished } from "vitest";
import { test } from "@sofia/testkit";
import { composerAttachmentToFilePart, resolveAttachmentFileMetadata } from "../../apps/app/src/react-app/domains/session/sync/attachment-file-part";
import { codexPromptFromParts } from "../../apps/app/src/react-app/domains/session/sync/codex-prompt-parts";

test("HEIC attachments use converted PNG bytes for native and Codex image inputs", async () => {
  const bytes=new Uint8Array([137,80,78,71,13,10,26,10]);
  const file=new File([new Uint8Array([1,2,3])],"original.heic",{type:"application/octet-stream"});
  expect(resolveAttachmentFileMetadata(file).kind).toBe("image");
  vi.stubGlobal("window",{__SOFIA_ELECTRON__:{images:{decodeHeic:async()=>bytes}}});
  onTestFinished(()=>vi.unstubAllGlobals());
  const part=await composerAttachmentToFilePart({id:"a",name:file.name,mimeType:"image/heic",size:file.size,kind:"image",file});
  expect(part).toMatchObject({filename:"original.png",mime:"image/png",url:"data:image/png;base64,iVBORw0KGgo="});
  if (!part) throw new Error("Missing supported image part");
  expect(codexPromptFromParts([{type:"text",text:"Review"},part]).images).toEqual([part.url]);
});

test("failed native decode rejects attachment instead of submitting mislabeled HEIC bytes", async () => {
  vi.stubGlobal("window",{__SOFIA_ELECTRON__:{images:{decodeHeic:async()=>{throw new Error("Cannot decode");}}}});
  onTestFinished(()=>vi.unstubAllGlobals());
  const file=new File([new Uint8Array([1])],"broken.heic",{type:"image/heic"});
  await expect(composerAttachmentToFilePart({id:"b",name:file.name,mimeType:file.type,size:file.size,kind:"image",file})).rejects.toThrow("Cannot decode");
});
