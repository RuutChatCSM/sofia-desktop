import { expect } from 'vitest';
import { test } from '@sofia/testkit';
import { transcriptDisplayParts } from '../../apps/app/src/react-app/domains/session/sync/transcript-display-parts';
import { largePasteAttachment } from '../../apps/app/src/react-app/domains/session/surface/composer/pasted-text';

test('large paste follows the shipped text and Markdown boundary without losing clipboard bytes', async ({ evidence }) => {
  const input = { text: 'x'.repeat(4999), attachmentsEnabled: true, disabled: false };
  expect(largePasteAttachment(input)).toBeNull();
  const plain = largePasteAttachment({ ...input, text: 'x'.repeat(5000) });
  expect(plain?.name).toBe('Pasted text.txt'); expect(plain?.type).toBe('text/plain');
  expect(await plain?.text()).toBe('x'.repeat(5000));
  const markdown = largePasteAttachment({ ...input, markdown: '# '.repeat(2500) });
  expect(markdown?.name).toBe('Pasted text.md'); expect(markdown?.type).toBe('text/markdown');
  expect(await markdown?.text()).toBe('# '.repeat(2500));
  const large = { ...input, text: 'x'.repeat(5000) };
  expect(largePasteAttachment({ ...large, disabled: true })).toBeNull();
  expect(largePasteAttachment({ ...large, attachmentsEnabled: false })).toBeNull();
  expect(largePasteAttachment({ ...large, voiceLayoutActive: true })).toBeNull();
  evidence.recordAssertionEvidence('Recovered clipboard threshold and gates', '4999 characters remain text; 5000 become a named text file with unchanged bytes. Markdown uses its own bytes, extension and type. Disabled, unavailable attachment and voice layout gates preserve the ordinary paste path.', true);
});


test('pasted file reaches transcript once without expanding its body into user text', async () => {
  const body = 'Wikipedia website text '.repeat(300);
  const file = largePasteAttachment({ text: body, attachmentsEnabled: true, disabled: false });
  if (!file) throw new Error('Expected large paste file');
  const parts = await transcriptDisplayParts({
    mode: 'prompt', text: 'Review this [attachment paste]', parts: [{type:'text',text:'Review this [attachment paste]'}],
    attachments: [{ id:'paste',name:file.name,mimeType:file.type,size:file.size,kind:'file',file }],
  }, new Map([['paste',{type:'file',filename:file.name,mime:file.type,url:'file:///workspace/Pasted%20text.txt'}]]));
  expect(parts).toEqual([{type:'text',text:'Review this ',state:'done'},{type:'file',mediaType:'text/plain',filename:'Pasted text.txt',url:'file:///workspace/Pasted%20text.txt'}]);
  expect(JSON.stringify(parts)).not.toContain(body);
});
