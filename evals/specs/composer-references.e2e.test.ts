import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { control, createAndSelectWorkspace, evalIn } from "@sofia/behaviors";
import { desktop } from "@sofia/hosts";
import { needs, test } from "@sofia/testkit";
import { expect, onTestFinished } from "vitest";

test("selecting a folder creates a durable atomic reference chip", { timeout: 5 * 60_000 }, async ({ evidence }) => {
  needs({ optIn: ["SOFIA_EVAL_E2E_TESTS"] });
  const workspace = await mkdtemp(join(tmpdir(), "sofia-reference-"));
  await mkdir(join(workspace, "target-folder"));
  await writeFile(join(workspace, "target-folder", "file.txt"), "Reference fixture");
  onTestFinished(() => rm(workspace, { recursive: true, force: true }));
  await using app = await desktop({ name: "composer-references" });
  await createAndSelectWorkspace(app, { path: workspace });
  await app.client.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await app.client.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await evalIn(app, `document.querySelector('[contenteditable="true"]')?.focus()`);
  await app.client.send("Input.insertText", { text: "@target-folder" });
  let selected = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    selected = Boolean(await evalIn(app, `(() => {
      const button = Array.from(document.querySelectorAll('button')).find((item) => item.textContent?.includes('target-folder') && item.textContent?.includes('Folder'));
      if (!button) return false;
      button.click(); return true;
    })()`));
    if (selected) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  expect(selected).toBe(true);
  for (let attempt = 0; attempt < 40; attempt++) {
    if (await evalIn(app, `Boolean(document.querySelector('[data-composer-reference="folder"]'))`)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  expect(await evalIn(app, `document.querySelector('[data-composer-reference="folder"]')?.textContent`)).toBe("target-folder");
  expect(await evalIn(app, `document.querySelectorAll('[data-composer-reference]').length`)).toBe(1);
  await app.client.send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 4 });
  await app.client.send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65 });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const clipboard = await evalIn(app, `(() => {
    const data = new DataTransfer();
    document.querySelector('[contenteditable="true"]').dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }));
    return { text: data.getData('text/plain').trim(), reference: data.getData('application/x-sofia-reference-text') };
  })()`);
  expect(clipboard).toMatchObject({ text: "target-folder" });
  expect(clipboard).toHaveProperty("reference", expect.stringContaining('[Folder: "'));
  await app.client.send("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 });
  await app.client.send("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 });
  const beforeDelete = await evalIn(app, `JSON.stringify({ active: document.activeElement?.outerHTML, anchor: window.getSelection()?.anchorNode?.textContent, offset: window.getSelection()?.anchorOffset })`);
  // The first Backspace removes the separator; the second removes the token.
  for (let index = 0; index < 2; index++) {
    await app.client.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
    await app.client.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  expect(await evalIn(app, `document.querySelectorAll('[data-composer-reference]').length`), String(beforeDelete)).toBe(0);
  await evalIn(app, `(() => {
    const copied = ${JSON.stringify(clipboard)};
    const data = new DataTransfer();
    data.setData('text/plain', copied.text);
    data.setData('application/x-sofia-reference-text', copied.reference);
    document.querySelector('[contenteditable="true"]').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(await evalIn(app, `document.querySelector('[data-composer-reference="folder"]')?.textContent`)).toBe("target-folder");
  await control(app, "session.create_task");
  for (let attempt = 0; attempt < 80; attempt++) {
    if (await evalIn(app, `window.__sofiaControl.listActions().some((action) => action.id === 'eval.chat_transcript.seed' && !action.disabled)`)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await control(app, "eval.chat_transcript.seed", { userText: '[Folder: "sofia-cloud/"] review its provider implementation' });
  for (let attempt = 0; attempt < 40; attempt++) {
    if (await evalIn(app, `Boolean(document.querySelector('[data-message-reference="folder"]'))`)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  expect(await evalIn(app, `document.querySelector('[data-message-reference="folder"]')?.textContent?.trim()`)).toBe("sofia-cloud");
  expect(await evalIn(app, `document.querySelector('[data-message-role="user"]')?.textContent`)).toContain("review its provider implementation");
  await evalIn(app, `document.querySelector('[data-message-role="user"] button[aria-label="Edit message"]')?.click()`);
  for (let attempt = 0; attempt < 40; attempt++) {
    if (await evalIn(app, `Boolean(document.querySelector('[data-composer-reference="folder"]'))`)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  expect(await evalIn(app, `document.querySelector('[data-composer-reference="folder"]')?.textContent`)).toBe("sofia-cloud");
  expect(await evalIn(app, `document.querySelector('[contenteditable="true"]')?.textContent`)).toContain("review its provider implementation");
  evidence.recordAssertionEvidence("Folder selection stays atomic in the actual composer", "The workspace picker creates exactly one friendly folder chip and Backspace removes it as a whole.", true);
  evidence.recordAssertionEvidence("Reference copy/paste preserves context inside Sofia", "Copy exposes the label as text/plain; the Sofia clipboard format restores the original folder as a chip after paste.", true);
  evidence.recordAssertionEvidence("The transcript displays a persisted reference beside its prose", "The actual transcript renderer reconstructs a folder chip from a text-only saved message and retains the request text.", true);
  evidence.recordAssertionEvidence("Editing a historical prompt restores its reference chip", "Edit message reconstructs the selected folder in the composer without a prior mention map.", true);
});
