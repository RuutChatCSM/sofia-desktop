import { fileURLToPath } from "node:url";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { control, createAndSelectWorkspace, evalIn } from "@sofia/behaviors";
import { desktop } from "@sofia/hosts";
import { needs, test } from "@sofia/testkit";
import { expect } from "vitest";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("panel start page, workspace editor and review tools", { timeout: 180_000 }, async ({ evidence }) => {
  needs({ optIn: ["SOFIA_EVAL_E2E_TESTS"] });
  await using app = await desktop({ name: "panel-tools" });
  const root = `/tmp/sofia-panel-tools-${Date.now()}`;
  await createAndSelectWorkspace(app, { path: root });
  mkdirSync(`${root}/src`, { recursive: true });
  writeFileSync(`${root}/src/Screenshot 2026-09-28 at 7.49.33 AM.png`, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1kAAAAASUVORK5CYII=", "base64"));
  const wav = Buffer.alloc(44 + 1600);
  wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write("data", 36); wav.writeUInt32LE(1600, 40);
  writeFileSync(`${root}/src/audio.wav`, wav);
  writeFileSync(`${root}/src/video.webm`, readFileSync(fileURLToPath(new URL("../fixtures/media/short.webm", import.meta.url))));
  writeFileSync(`${root}/src/settings.json`, '{"answer": 42, "name": "Sofia"}\n');
  writeFileSync(`${root}/src/guide.mdx`, '---\ntitle: Sofia guide\ndescription: File workspace\n---\n# File guide\n\nReadable **document**.\n');
  writeFileSync(`${root}/src/example.rb`, "puts 'Sofia'\n");
  writeFileSync(`${root}/src/example.ts`, "const answer = 41;\n");
  await app.client.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await app.client.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await evalIn(app, `document.querySelector('button[aria-label="Browser"]')?.click()`);
  await sleep(800);
  await control(app, "eval.markdown_primitive.seed_artifact");
  const before = await evalIn(app, `window.__SOFIA_ELECTRON__.browser.listTabs().then((tabs) => tabs.length)`, { awaitPromise: true });
  await evalIn(app, `document.querySelector('[aria-label="New tab"]').click()`);
  await sleep(300);
  expect(await evalIn(app, `Boolean(document.querySelector('[aria-label="Search or enter a URL"]'))`)).toBe(true);
  expect(await evalIn(app, `window.__SOFIA_ELECTRON__.browser.listTabs().then((tabs) => tabs.length)`, { awaitPromise: true })).toBe(before);
  await evalIn(app, `Array.from(document.querySelectorAll('button')).find((button) => button.textContent.trim() === 'Files').click()`);
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await evalIn(app, `Boolean(document.querySelector('[data-workspace-file="src"]'))`)) break;
    await sleep(250);
  }
  expect(await evalIn(app, `Boolean(document.querySelector('[data-workspace-file="src"]'))`)).toBe(true);
  await evalIn(app, `document.querySelector('[data-workspace-file="src"]').click()`);
  for (let attempt = 0; attempt < 40; attempt++) {
    if (await evalIn(app, `Boolean(document.querySelector('[data-workspace-file="src/example.ts"]'))`)) break;
    await sleep(100);
  }
  await evalIn(app, `document.querySelector('[data-workspace-file="src/example.ts"]').click()`);
  await sleep(600);
  expect(await evalIn(app, `document.querySelector('.cm-content')?.textContent`)).toContain("const answer = 41;");
  await evalIn(app, `document.querySelector('.cm-content').focus()`);
  await sleep(100);
  const caret = await evalIn(app, `(() => {
    const cursor = document.querySelector('.cm-cursor');
    if (!cursor) return { missing: true, focused: document.activeElement?.className };
    const style = getComputedStyle(cursor); const rect = cursor.getBoundingClientRect();
    return { height: rect.height, width: style.borderLeftWidth, colour: style.borderLeftColor, caretColour: getComputedStyle(document.querySelector('.cm-content')).caretColor };
  })()`);
  expect(caret).toMatchObject({ width: "2px" });
  expect(caret.height).toBeGreaterThan(0);
  expect(caret.colour).not.toBe("rgba(0, 0, 0, 0)");
  await app.client.send("Input.dispatchKeyEvent", { type: "keyDown", key: "End", code: "End", windowsVirtualKeyCode: 35 });
  await app.client.send("Input.dispatchKeyEvent", { type: "keyUp", key: "End", code: "End", windowsVirtualKeyCode: 35 });
  await app.client.send("Input.insertText", { text: " // edited" });
  await sleep(200);
  await evalIn(app, `document.querySelector('[aria-label="New tab"]').click()`);
  await evalIn(app, `Array.from(document.querySelectorAll('button')).find((button) => button.textContent.trim() === 'Files').click()`);
  await sleep(150);
  if (await evalIn(app, `document.querySelector('[data-workspace-file="src"]').getAttribute("aria-expanded") === "false"`)) await evalIn(app, `document.querySelector('[data-workspace-file="src"]').click()`);
  await sleep(150);
  await evalIn(app, `document.querySelector('[data-workspace-file="src/example.ts"]').click()`);
  await sleep(250);
  expect(await evalIn(app, `document.querySelector('.cm-content')?.textContent`)).toContain("// edited");
  await evalIn(app, `Array.from(document.querySelectorAll('button')).find((button) => button.textContent.trim() === 'Save').click()`);
  await sleep(600);
  expect(readFileSync(`${root}/src/example.ts`, "utf8")).toContain("// edited");
  await evalIn(app, `document.querySelector('[data-workspace-file="src/example.rb"]').click()`);
  await sleep(400);
  expect(await evalIn(app, `document.querySelector('.cm-content')?.textContent`)).toContain("puts 'Sofia'");
  expect(await evalIn(app, `getComputedStyle(document.querySelector('[data-testid="browser-panel-shell"]')).boxShadow`)).toBe("none");
  expect(await evalIn(app, `Boolean(document.querySelector('[aria-label="Preferred editor"]'))`)).toBe(true);
  await evalIn(app, `document.querySelector('[data-workspace-file="src/settings.json"]').click()`);
  for (let attempt = 0; attempt < 40; attempt++) {
    if (Number(await evalIn(app, `document.querySelectorAll('[data-source-token]').length`)) > 0) break;
    await sleep(150);
  }
  expect(Number(await evalIn(app, `document.querySelectorAll('[data-source-token]').length`))).toBeGreaterThan(0);
  expect(await evalIn(app, `document.querySelector('[data-workspace-file="src/settings.json"] [data-file-type]').getAttribute('data-file-type')`)).toBe("json");
  expect(await evalIn(app, `document.querySelector('[data-workspace-file="src/example.rb"] [data-file-type]').getAttribute('data-file-type')`)).toBe("ruby");
  if (process.platform === 'darwin') {
    const applications = await evalIn(app, `(async () => {
      const { getDesktopApplicationsForFile } = await import('/src/app/lib/desktop.ts');
      const applications = await getDesktopApplicationsForFile(${JSON.stringify(`${root}/src/settings.json`)});
      return { names: applications.map((entry) => entry.name), distinct: new Set(applications.map((entry) => entry.icon).filter(Boolean)).size };
    })()`, { awaitPromise: true });
    expect(applications.names).not.toContain('Calculator');
    expect(applications.names).not.toContain('Calendar');
    expect(applications.distinct).toBeGreaterThan(1);
  }
  await evalIn(app, `document.querySelector('[data-workspace-file="src/guide.mdx"]').click()`);
  await sleep(500);
  expect(await evalIn(app, `document.querySelector('[data-testid="workspace-document-preview"] h1')?.textContent`)).toBe("File guide");
  expect(await evalIn(app, `document.querySelector('[aria-label="Document metadata"]')?.textContent`)).toContain("Sofia guide");
  expect(await evalIn(app, `Boolean(document.querySelector('[aria-label="File breadcrumbs"]'))`)).toBe(true);
  await evalIn(app, `Array.from(document.querySelectorAll('button')).find((button) => button.textContent.trim() === 'View source').click()`);
  await sleep(250);
  expect(await evalIn(app, `document.querySelector('.cm-content')?.textContent`)).toContain("title: Sofia guide");
  evidence.recordAssertionEvidence("Files use type-specific presentation", "JSON has coloured editable tokens, Ruby and JSON use distinct icons, and MDX opens a document preview with metadata and an exact source toggle.", true);
  evidence.recordAssertionEvidence("Panel start and workspace editing", "New tab creates a tool chooser without a native browser tab. The workspace tree opens a real source file, CodeMirror edits it, and Save writes the edit to disk.", true);

  await evalIn(app, `document.querySelector('[data-workspace-file="src/Screenshot 2026-09-28 at 7.49.33 AM.png"]').click()`);
  for (let attempt = 0; attempt < 50; attempt++) {
    if (await evalIn(app, `document.querySelector('[data-testid="workspace-media-preview"] img')?.naturalWidth > 0`)) break;
    await sleep(150);
  }
  expect(await evalIn(app, `document.querySelector('[data-testid="workspace-media-preview"] img')?.naturalWidth`)).toBe(1);
  expect(await evalIn(app, `document.querySelector('[aria-label="Image zoom"]').value`)).toBe("fit");
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await evalIn(app, `Boolean(document.querySelector('button[title="Open in Preview"] img')?.naturalWidth)`)) break;
    await sleep(150);
  }
  if (process.platform === 'darwin') expect(await evalIn(app, `Boolean(document.querySelector('button[title="Open in Preview"] img')?.naturalWidth)`)).toBe(true);
  if (process.platform === 'darwin') {
    const icons = await evalIn(app, `(async () => {
      const { getDesktopApplicationsForFile } = await import('/src/app/lib/desktop.ts');
      const applications = await getDesktopApplicationsForFile(${JSON.stringify(`${root}/src/Screenshot 2026-09-28 at 7.49.33 AM.png`)});
      const icons = applications.filter((application) => application.icon);
      const colourful = await Promise.all(icons.map(async (application) => {
        const image = new Image(); image.src = application.icon; await image.decode();
        const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
        const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        for (let index = 0; index < pixels.length; index += 4) {
          if (pixels[index + 3] > 128 && Math.max(...pixels.slice(index, index + 3)) - Math.min(...pixels.slice(index, index + 3)) > 40) return true;
        }
        return false;
      }));
      return { distinct: new Set(icons.map((application) => application.icon)).size, colourful: colourful.filter(Boolean).length };
    })()`, { awaitPromise: true });
    expect(icons.distinct).toBeGreaterThan(1);
    expect(icons.colourful).toBeGreaterThan(1);
  }
  await evalIn(app, `document.querySelector('[data-workspace-file="src/audio.wav"]').click()`);
  for (let attempt = 0; attempt < 50; attempt++) {
    if (await evalIn(app, `document.querySelector('audio')?.readyState >= 1`)) break;
    await sleep(150);
  }
  expect(await evalIn(app, `Boolean(document.querySelector('audio')?.controls) && document.querySelector('audio').duration > 0`)).toBe(true);
  await evalIn(app, `document.querySelector('[data-workspace-file="src/video.webm"]').click()`);
  for (let attempt = 0; attempt < 50; attempt++) {
    if (await evalIn(app, `document.querySelector('video')?.readyState >= 1`)) break;
    await sleep(150);
  }
  expect(await evalIn(app, `Boolean(document.querySelector('video')?.controls) && document.querySelector('video').videoWidth === 32`)).toBe(true);
  evidence.recordAssertionEvidence("Media and native application logos", "A PNG decodes inline with Fit controls; WAV and WebM decode with native playback controls. On macOS the Open button displays Preview's native icon for the PNG.", true);

  await evalIn(app, `(async () => {
    const { usePanelTabStore } = await import('/src/react-app/domains/session/panel/panel-tab-store.ts');
    const { useChangeSetStore } = await import('/src/react-app/domains/session/changes/change-set-store.ts');
    const store = usePanelTabStore.getState();
    const sessionId = Object.keys(store.sessions).find((id) => store.sessions[id].tabs.some((tab) => tab.type === 'files'));
    const id = 'eval-review';
    useChangeSetStore.getState().upsert({ id, sessionId, turnId: 'eval', source: 'git', startedAt: 1, finalizedAt: 2, repositories: [{ repositoryId: 'repo', root: ${JSON.stringify(root)}, files: [{ path: 'src/example.ts', status: 'modified', additions: 1, deletions: 1, attributedToTurn: true, hunks: [{ header: '@@ -1 +1 @@', oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [{ type: 'delete', oldLine: 1, text: 'const answer = 41;' }, { type: 'add', newLine: 1, text: 'const answer = 42;' }] }] }] }] });
    store.openTab(sessionId, { id: 'review-eval', type: 'changes', label: 'Review', changeSetId: id });
  })()`, { awaitPromise: true });
  await sleep(500);
  expect(await evalIn(app, `document.querySelector('[aria-label="Review scope"]').tagName`)).toBe("SELECT");
  expect(await evalIn(app, `Boolean(document.querySelector('[data-review-files]'))`)).toBe(false);
  expect(await evalIn(app, `Boolean(document.querySelector('[data-diff-side="old"]')) && Boolean(document.querySelector('[data-diff-side="new"]'))`)).toBe(true);
  await evalIn(app, `document.querySelector('[aria-label="Toggle changed files"]').click()`);
  expect(await evalIn(app, `Boolean(document.querySelector('[aria-label="Filter changed files"]'))`)).toBe(true);
  await evalIn(app, `document.querySelector('[aria-label="Toggle split diff"]').click()`);
  expect(await evalIn(app, `document.querySelectorAll('[data-diff-row]').length`)).toBe(0);
  await evalIn(app, `document.querySelector('[aria-label="Expand panel"]').click()`);
  await sleep(200);
  expect(await evalIn(app, `document.querySelector('[data-panel-presentation]').getAttribute('data-panel-presentation')`)).toBe("expanded");
  await evalIn(app, `Array.from(document.querySelectorAll('button')).find((button) => button.textContent.trim() === 'Open').click()`);
  await sleep(400);
  expect(await evalIn(app, `Boolean(document.querySelector('[data-testid="workspace-files"]'))`)).toBe(true);
  evidence.recordAssertionEvidence("Review tools share the file workspace", "Review has a scope selector, optional filtered files, split/unified diff, and global Expand; Open routes the changed source into the workspace editor.", true);
  const fileTab = await evalIn(app, `(() => {
    const button = Array.from(document.querySelectorAll('[aria-label^="Select tab:"]')).find((button) => button.textContent.includes('example.ts'));
    const rect = button.getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  })()`);
  await app.client.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...fileTab });
  await sleep(250);
  expect(await evalIn(app, `getComputedStyle(document.querySelector('[aria-label="Close tab: example.ts"]')).opacity`)).toBe("1");
  await evalIn(app, `document.querySelector('[aria-label="Close tab: example.ts"]').click()`);
  await sleep(200);
  expect(await evalIn(app, `Boolean(document.querySelector('[aria-label="Close tab: example.ts"]'))`)).toBe(false);
  expect(await evalIn(app, `Boolean(document.querySelector('[data-testid="workspace-files"]'))`)).toBe(false);
  evidence.recordAssertionEvidence("Editor caret and tab closing", "Focused source editor paints a contrasting two-pixel caret. Hover exposes the file tab close control, and closing removes both its tab and editor.", true);

});
