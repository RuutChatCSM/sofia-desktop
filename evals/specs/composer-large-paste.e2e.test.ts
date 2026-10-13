import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAndSelectWorkspace, evalIn } from '@sofia/behaviors';
import { desktop } from '@sofia/hosts';
import { needs, test } from '@sofia/testkit';
import { expect, onTestFinished } from 'vitest';

test('actual composer routes large text to one attachment and IME Enter retains its draft', { timeout: 300_000 }, async ({ evidence }) => {
  needs({ optIn: ['SOFIA_EVAL_E2E_TESTS'] });
  const workspace = await mkdtemp(join(tmpdir(), 'sofia-paste-'));
  onTestFinished(() => rm(workspace, { recursive: true, force: true }));
  await using app = await desktop({ name: 'composer-large-paste' });
  await createAndSelectWorkspace(app, { path: workspace });
  await evalIn(app, `document.querySelector('[contenteditable="true"]')?.focus()`);
  await app.client.send('Input.insertText', { text: 'Keep this draft' });
  const before = await evalIn(app, `document.querySelector('[contenteditable="true"]')?.textContent`);
  await evalIn(app, `(() => { const editor = document.querySelector('[contenteditable="true"]');
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true }));
  })()`);
  expect(await evalIn(app, `document.querySelector('[contenteditable="true"]')?.textContent`)).toBe(before);
  await app.client.send('Browser.grantPermissions', { permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
  // Use the native clipboard/edit command: a synthetic ClipboardEvent does not
  // reproduce Chromium's native editor listener and rich website clipboard.
  await evalIn(app, `(async () => {
    window.__sofiaSavedClipboard = await navigator.clipboard.read();
    window.__sofiaPasteEvents = [];
    document.addEventListener('paste', event => {
      window.__sofiaPasteEvents.push({ trusted: event.isTrusted, html: event.clipboardData.getData('text/html').length });
    }, { capture: true });
    await navigator.clipboard.write([new ClipboardItem({
      'text/plain': new Blob(['z'.repeat(5000)], { type: 'text/plain' }),
      'text/html': new Blob(['<article><h1>Wikipedia fixture</h1><p>' + 'z'.repeat(5000) + '</p></article>'], { type: 'text/html' }),
    })]);
  })()`);
  try {
    await evalIn(app, `document.querySelector('[contenteditable="true"]')?.focus()`);
    await app.client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, modifiers: 4, commands: ['paste'] });
    await app.client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, modifiers: 4 });
    for (let attempt = 0; attempt < 40; attempt++) {
      if (await evalIn(app, `window.__sofiaPasteEvents.length > 0`)) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    expect(await evalIn(app, `window.__sofiaPasteEvents`)).toEqual([{trusted:true,html:expect.any(Number)}]);
  } finally {
    await evalIn(app, `(async () => {
      if (window.__sofiaSavedClipboard.length) await navigator.clipboard.write(window.__sofiaSavedClipboard);
      else await navigator.clipboard.writeText('');
      delete window.__sofiaSavedClipboard;
    })()`);
  }
  let attached = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    attached = Boolean(await evalIn(app, `Array.from(document.querySelectorAll('[data-attachment-id]')).some(node => node.textContent.includes('Pasted text.txt'))`));
    if (attached) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  expect(attached).toBe(true);
  const pasteEvents = await evalIn(app, `window.__sofiaPasteEvents`);
  expect(pasteEvents).toEqual([{ trusted: true, html: expect.any(Number) }]);
  expect(await evalIn(app, `window.__sofiaPasteEvents[0].html > 5000`)).toBe(true);
  expect(await evalIn(app, `document.querySelectorAll('[data-attachment-id]').length`)).toBe(1);
  expect(await evalIn(app, `document.querySelector('[contenteditable="true"]')?.textContent`)).toContain('Keep this draft');
  expect(await evalIn(app, `document.querySelector('[contenteditable="true"]')?.textContent`)).not.toContain('z'.repeat(100));
  evidence.recordAssertionEvidence('Real composer native rich paste routing and IME', 'In an isolated Electron workspace, IME Enter preserves the draft, and a native clipboard paste with text/plain plus HTML creates exactly one Pasted text.txt attachment without injecting the clipboard body into the editor.', true);
});
