import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { expect, onTestFinished } from "vitest";
import { test } from "@sofia/testkit";

test("real Electron restart restores session tabs and history lazily, retains browser data, and respects explicit close", { timeout: 120000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "sofia-browser-restart-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const visits: string[] = [];
  const server = createServer((request, response) => {
    visits.push(request.url ?? "");
    response.writeHead(200, { "Content-Type": "text/html", "Set-Cookie": "restoration-proof=yes; Max-Age=3600; Path=/" });
    response.end(`<html><title>Saved ${request.url}</title><body>Restoration fixture</body></html>`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture server missing");
  const base = `http://127.0.0.1:${address.port}`;
  const require = createRequire(resolve("../apps/desktop/package.json"));
  const electron = require("electron");
  async function launch(stage: string) {
    const report = join(root, `${stage}.json`);
    const log: string[] = [];
    const electronEnv = { ...process.env };
    delete electronEnv.ELECTRON_RUN_AS_NODE;
    const child = spawn(electron, [resolve("fixtures/browser-workspace-restart.mjs"), join(root, "profile"), stage, base, report], { env: electronEnv, stdio: ["ignore", "pipe", "pipe"] });
    onTestFinished(() => { if (child.exitCode === null) child.kill(); });
    child.stdout.on("data", chunk => log.push(String(chunk)));
    child.stderr.on("data", chunk => log.push(String(chunk)));
    const code = await new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("exit", resolve); });
    const result = JSON.parse(await readFile(report, "utf8").catch(() => "{}"));
    if (code !== 0) throw new Error(JSON.stringify({ code, result, log }));
    return result;
  }
  const created = await launch("create");
  expect(created.frames.map((frame: { presentation: string }) => frame.presentation)).toEqual(["docked", "expanded"]);
  for (const frame of created.frames) {
    expect(frame.container).toEqual({ x: 400, y: 130, width: 600, height: 500 });
    expect(frame.page).toEqual({ x: 0, y: 0, width: 600, height: 500 });
    // Native framing preserves the canvas's absolute origin and viewport.
    expect(frame.container.y + frame.page.y).toBe(130);
    expect(frame.container.y + frame.container.height).toBe(630);
    if (process.platform === "darwin") {
      expect(frame.corners.left).toEqual(frame.corners.backdrop);
      expect(frame.corners.right).toEqual(frame.corners.backdrop);
      expect(frame.corners.center).toEqual([255, 255, 255]);
    }
  }
  expect(created.state.activeTabId).toBe(created.first);
  expect(created.state.tabs.map((tab: { id: string }) => tab.id)).toEqual([created.second, created.first]);
  visits.length = 0;
  const restored = await launch("restore");
  expect(restored.initial.tabs).toEqual([]);
  expect(restored.activations).toEqual([]);
  expect(restored.restored.scopeId).toBe("session:A");
  expect(restored.restored.activeTabId).toBe(created.first);
  expect(restored.restored.tabs.map((tab: { id: string }) => tab.id)).toEqual([created.second, created.first]);
  expect(restored.storage).toBe("survived");
  expect(restored.cookieRestored).toBe(true);
  expect(restored.entries).toContain(`${base}/first`);
  expect(restored.entries[restored.historyIndex]).toBe(`${base}/second`);
  expect(restored.restored.tabs.every((tab: { agentState: { status: string } }) => tab.agentState.status === "detached")).toBe(true);
  expect(visits).not.toContain("/background");
  expect(visits).not.toContain("/other");
  const reopened = await launch("verify-close");
  expect(reopened.restored.tabs.map((tab: { id: string }) => tab.id)).toEqual([created.first]);
  expect(reopened.remainingOther.tabs.map((tab: { id: string }) => tab.id)).toEqual([created.other]);
});
