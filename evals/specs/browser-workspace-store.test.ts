import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, onTestFinished } from "vitest";
import { test } from "@sofia/testkit";
import { createBrowserWorkspaceStore, MAX_BROWSER_WORKSPACE_BYTES } from "../../apps/desktop/electron/browser-workspace-store.mjs";

test("native snapshots preserve history, selected tab, scope ownership, order and explicit close across fresh stores", async () => {
  const root = await mkdtemp(join(tmpdir(), "sofia-browser-store-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "state.json");
  const store = createBrowserWorkspaceStore(file);
  const make = (id: string, scopeId: string) => ({ id, scopeId, url: "https://example.test/two", title: id, favicon: null, updatedAt: 1,
    navigation: { entries: [{ url: "https://example.test/one", title: "First", pageState: "opaque" }, { url: "https://example.test/two", title: "Second" }], index: 1 } });
  store.upsert(make("a", "session:A")); store.upsert(make("b", "session:A")); store.upsert(make("c", "session:B"));
  store.select("session:A", "a"); store.select("session:B", "c"); store.reorder("session:A", ["b", "a"]);
  store.upsert({ ...make("a", "session:B"), title: "hijacked" });
  store.flush();
  const restored = createBrowserWorkspaceStore(file);
  expect(restored.list("session:A").map(tab => tab.id)).toEqual(["b", "a"]);
  expect(restored.selected("session:A")).toBe("a");
  expect(restored.list("session:A")[1]).toEqual(make("a", "session:A"));
  restored.remove("b"); restored.flush();
  const reopened = createBrowserWorkspaceStore(file);
  expect(reopened.list("session:A").map(tab => tab.id)).toEqual(["a"]);
  expect(reopened.list("session:B").map(tab => tab.id)).toEqual(["c"]);
});

test("native snapshot files are bounded and reject corrupt versions and executable URLs", async () => {
  const root = await mkdtemp(join(tmpdir(), "sofia-browser-bound-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "state.json");
  const store = createBrowserWorkspaceStore(file);
  for (let index = 0; index < 140; index++) store.upsert({ id: `t${index}`, scopeId: "scope", url: "https://example.test", updatedAt: index });
  store.upsert({ id: "bad", scopeId: "scope", url: "javascript:alert(1)" });
  store.flush();
  const restored = createBrowserWorkspaceStore(file);
  expect(restored.list("scope")).toHaveLength(100);
  expect(restored.list("scope").find(tab => tab.id === "t0")).toBeUndefined();
  expect(Buffer.byteLength(await readFile(file))).toBeLessThan(MAX_BROWSER_WORKSPACE_BYTES);
  await writeFile(file, "{broken");
  expect(createBrowserWorkspaceStore(file).list("scope")).toEqual([]);
  await writeFile(file, JSON.stringify({ version: 99, tabs: [{ id: "t", scopeId: "scope", url: "https://example.test" }] }));
  expect(createBrowserWorkspaceStore(file).list("scope")).toEqual([]);
});
