import { expect } from "vitest";
import { evalIn, waitFor } from "@sofia/behaviors";
import { desktop } from "@sofia/hosts";
import { needs, test } from "@sofia/testkit";

test("durable composer recovery keeps File bytes and requires explicit retry for uncertain sends", { timeout: 180_000 }, async ({ evidence }) => {
  needs({ optIn: ["SOFIA_EVAL_E2E_TESTS"], placement: "local" });
  await using app = await desktop({ name: "composer-queue-recovery" });
  await evalIn(app, `(async()=>{
    const {ComposerQueuePersistence,composerQueueIndexedDbBackend}=await import('/src/react-app/domains/session/surface/composer-queue-persistence.ts');
    const {QueuedMessagesPanel}=await import('/src/react-app/domains/session/modals/queued-messages-panel.tsx');
    const React=(await import('/node_modules/.vite/deps/react.js')).default;
    const {createRoot}=(await import('/node_modules/.vite/deps/react-dom_client.js')).default;
    const repository=new ComposerQueuePersistence(composerQueueIndexedDbBackend());
    const file=new File(['survives reload'],'queued.txt',{type:'text/plain'});
    await repository.save({proof:[{id:'uncertain',deliveryState:'sending',draft:{mode:'prompt',text:'Review queued.txt',parts:[{type:'text',text:'Review queued.txt'}],attachments:[{id:'file',name:file.name,size:file.size,mimeType:file.type,kind:'file',file,previewUrl:'blob:old-renderer'}]}}]});
    const fresh=new ComposerQueuePersistence(composerQueueIndexedDbBackend());
    const restored=await fresh.load();
    window.__queueRecoveryProof={restored,retries:0,fileBytes:await restored.proof[0].draft.attachments[0].file.text(),fileName:restored.proof[0].draft.attachments[0].file.name};
    const container=document.createElement('div');container.id='queue-recovery-proof';document.body.append(container);
    createRoot(container).render(React.createElement(QueuedMessagesPanel,{items:restored.proof,onRemove:()=>{},onSendNow:()=>{window.__queueRecoveryProof.retries++},onReorder:()=>{},onEdit:()=>{}}));
  })()`, { awaitPromise: true });
  await waitFor(app, `document.querySelector('#queue-recovery-proof')?.textContent.includes('Delivery unconfirmed')`, { label: "recovery warning rendered" });
  expect(await evalIn(app, `window.__queueRecoveryProof.fileBytes`)).toBe("survives reload");
  expect(await evalIn(app, `window.__queueRecoveryProof.fileName`)).toBe("queued.txt");
  expect(await evalIn(app, `window.__queueRecoveryProof.restored.proof[0].draft.attachments[0].previewUrl??null`)).toBe(null);
  expect(await evalIn(app, `window.__queueRecoveryProof.restored.proof[0].deliveryState`)).toBe("outcome-unknown");
  expect(await evalIn(app, `window.__queueRecoveryProof.retries`)).toBe(0);
  await evalIn(app, `[...document.querySelectorAll('#queue-recovery-proof button')].find(button=>button.textContent.trim()==='Retry').click()`);
  expect(await evalIn(app, `window.__queueRecoveryProof.retries`)).toBe(1);
  await evalIn(app, `(async()=>{
    const {useComposerStateStore,retryComposerQueueRecovery,flushComposerQueuePersistence}=await import('/src/react-app/domains/session/surface/composer-state-store.ts');
    const open=indexedDB.open.bind(indexedDB);
    try {
      indexedDB.open=()=>{throw Error('Temporary read failure')};
      await retryComposerQueueRecovery();
      window.__queueRecoveryProof.readError=useComposerStateStore.getState().queueStorageError;
      useComposerStateStore.getState().appendQueuedDraft('new-unsent',{mode:'prompt',text:'Keep new draft',parts:[{type:'text',text:'Keep new draft'}],attachments:[]});
      try { await flushComposerQueuePersistence(); window.__queueRecoveryProof.blocked=false; }
      catch { window.__queueRecoveryProof.blocked=true; }
    } finally { indexedDB.open=open; }
    await retryComposerQueueRecovery();
    const shape=useComposerStateStore.getState().queuedDrafts;
    window.__queueRecoveryProof.afterRecovery={oldBytes:await shape.proof[0].draft.attachments[0].file.text(),newText:shape['new-unsent'][0].draft.text,error:useComposerStateStore.getState().queueStorageError};
  })()`, { awaitPromise: true });
  expect(await evalIn(app, `window.__queueRecoveryProof.readError`)).toContain("could not be restored");
  expect(await evalIn(app, `window.__queueRecoveryProof.blocked`)).toBe(true);
  expect(await evalIn(app, `window.__queueRecoveryProof.afterRecovery`)).toEqual({ oldBytes: "survives reload", newText: "Keep new draft", error: null });
  evidence.recordAssertionEvidence("Durable queue recovery", "Fresh production repository reads a queued File from actual Electron IndexedDB with original bytes/name; expired object URL is absent, sending becomes outcome-unknown, and the real queue panel renders a warning without dispatch until explicit Retry. No provider inference.", true);
});
