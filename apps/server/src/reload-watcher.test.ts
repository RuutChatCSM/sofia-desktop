import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ReloadEventStore } from "./events.js";
import { startReloadWatchers } from "./reload-watcher.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";
import { ensureWorkspaceFiles } from "./workspace-init.js";

async function withWorkspace(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "sofia-reload-watcher-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function buildConfig(root: string): { config: ServerConfig; workspace: WorkspaceInfo } {
  const workspace: WorkspaceInfo = {
    id: "ws_reload_test",
    name: "Reload Test",
    path: root,
    preset: "starter",
    workspaceType: "local",
  };
  return {
    workspace,
    config: {
      host: "127.0.0.1",
      port: 0,
      token: "token",
      hostToken: "host-token",
      approval: { mode: "auto", timeoutMs: 0 },
      corsOrigins: [],
      workspaces: [workspace],
      authorizedRoots: [root],
      readOnly: false,
      startedAt: Date.now(),
      tokenSource: "env",
      hostTokenSource: "env",
      logFormat: "pretty",
      logRequests: false,
    },
  };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForEvent(store: ReloadEventStore, workspaceId: string) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const items = store.list(workspaceId);
    if (items.length > 0) return items[0];
    await sleep(25);
  }
  return null;
}

describe("reload watcher fingerprints", () => {
  test("does not emit when a watched file is rewritten with identical content", async () => {
    await withWorkspace(async (root) => {
      const { config, workspace } = buildConfig(root);
      const skillDir = join(root, ".sofia", "skills", "demo");
      const configPath = join(skillDir, "SKILL.md");
      const content = "---\nname: demo\ndescription: Demo\n---\nbody\n";
      await mkdir(skillDir, { recursive: true });
      await writeFile(configPath, content, "utf8");

      const events = new ReloadEventStore();
      const watcher = startReloadWatchers({ config, reloadEvents: events, debounceMs: 30 });
      try {
        await watcher.refreshWorkspace(workspace.id);
        await writeFile(configPath, content, "utf8");
        await sleep(120);

        expect(events.list(workspace.id)).toEqual([]);
      } finally {
        watcher.close();
      }
    });
  });

  test("emits when a workspace skill changes while running", async () => {
    await withWorkspace(async (root) => {
      const { config, workspace } = buildConfig(root);
      const skillDir = join(root, ".sofia", "skills", "demo");
      await mkdir(skillDir, { recursive: true });
      await writeFile(join(skillDir, "SKILL.md"), "---\nname: demo\n---\nbody\n", "utf8");

      const events = new ReloadEventStore();
      const watcher = startReloadWatchers({ config, reloadEvents: events, debounceMs: 30 });
      try {
        await watcher.refreshWorkspace(workspace.id);
        await sleep(300);
        await writeFile(join(skillDir, "SKILL.md"), "---\nname: demo\n---\nchanged\n", "utf8");

        const event = await waitForEvent(events, workspace.id);
        expect(event?.reason).toBe("skills");
      } finally {
        watcher.close();
      }
    });
  });

  test("suppresses internal workspace bootstrap writes after refreshing the baseline", async () => {
    await withWorkspace(async (root) => {
      const { config, workspace } = buildConfig(root);
      const events = new ReloadEventStore();
      const watcher = startReloadWatchers({ config, reloadEvents: events, debounceMs: 100 });
      try {
        await watcher.refreshWorkspace(workspace.id);
        const ensured = await ensureWorkspaceFiles(root, "starter");
        await watcher.refreshWorkspace(workspace.id, ensured.reloadReasons);
        await sleep(250);

        expect(ensured.reloadReasons.sort()).toEqual([]);
        expect(events.list(workspace.id)).toEqual([]);
      } finally {
        watcher.close();
      }
    });
  });

  test("watches workspace command files", async () => {
    await withWorkspace(async (root) => {
      const { config, workspace } = buildConfig(root);
      const commandsDir = join(root, ".sofia", "commands");
      await mkdir(commandsDir, { recursive: true });

      const events = new ReloadEventStore();
      const watcher = startReloadWatchers({ config, reloadEvents: events, debounceMs: 30 });
      try {
        await watcher.refreshWorkspace(workspace.id);
        await sleep(300);
        await sleep(75);
        await sleep(75);
        await writeFile(join(commandsDir, "demo.md"), "---\nname: demo\n---\nbody\n", "utf8");

        const event = await waitForEvent(events, workspace.id);
        expect(event?.reason).toBe("commands");
      } finally {
        watcher.close();
      }
    });
  });
});
