import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { auditLogPath } from "./audit.js";
import { buildCommandContent } from "./commands.js";
import { startServer } from "./server.js";
import { buildSkillContent } from "./skills.js";
import type { ServerConfig } from "./types.js";
import {
  buildWorkspaceImportPreview,
  publicWorkspaceImportPreview,
  summarizeWorkspaceImportApplied,
  summarizeWorkspaceImportPreview,
  workspaceImportPreviewApprovalPaths,
} from "./workspace-import-preview.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sofia-import-preview-"));
  tempDirs.push(dir);
  await mkdir(join(dir, ".sofia"), { recursive: true });
  return dir;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function makeServerConfig(workspace: string, dataDir: string): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    token: "test-token",
    hostToken: "host-token",
    configPath: join(dataDir, "config.json"),
    approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: [],
    workspaces: [
      {
        id: "workspace",
        name: "workspace",
        path: workspace,
        preset: "default",
        workspaceType: "local",
      },
    ],
    authorizedRoots: [workspace],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "generated",
    hostTokenSource: "generated",
    logFormat: "pretty",
    logRequests: false,
  };
}

type TestHeaders = {
  Authorization: string;
  "Content-Type": string;
};

async function requestWorkspaceImportPreview(
  baseUrl: string,
  headers: TestHeaders,
  payload: Record<string, unknown>,
): Promise<{ fingerprint: string; summary: { create: number; update: number; delete: number; unchanged: number } }> {
  const response = await fetch(`${baseUrl}/workspace/workspace/import/preview`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  expect(response.status).toBe(200);
  return await response.json() as {
    fingerprint: string;
    summary: { create: number; update: number; delete: number; unchanged: number };
  };
}

async function requestWorkspaceImportWithPreview(
  baseUrl: string,
  headers: TestHeaders,
  payload: Record<string, unknown>,
): Promise<Response> {
  const preview = await requestWorkspaceImportPreview(baseUrl, headers, payload);
  return await fetch(`${baseUrl}/workspace/workspace/import`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ...payload, previewFingerprint: preview.fingerprint }),
  });
}

async function silenceExpectedServerError<T>(run: () => Promise<T>): Promise<T> {
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    if (args[0] === "[sofia-server] Unhandled error:") return;
    originalError(...args);
  };
  try {
    return await run();
  } finally {
    console.error = originalError;
  }
}

async function waitForPendingApproval(baseUrl: string): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await fetch(`${baseUrl}/approvals`, {
      headers: { "X-Sofia-Host-Token": "host-token" },
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { items: Array<{ id: string }> };
    const approval = body.items[0];
    if (approval) return approval.id;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for approval request");
}

describe("workspace import preview", () => {
  test("summarizes workspace import changes without writing files", async () => {
    const workspace = await makeWorkspace();
    await writeFile(join(workspace, "engine.jsonc"), '{ "plugin": ["old-plugin"] }\n', "utf8");
    await mkdir(join(workspace, ".sofia", "skills", "demo"), { recursive: true });
    await writeFile(join(workspace, ".sofia", "skills", "demo", "SKILL.md"), "old skill\n", "utf8");
    await mkdir(join(workspace, ".sofia", "commands"), { recursive: true });
    await writeFile(join(workspace, ".sofia", "commands", "old.md"), "old command\n", "utf8");
    await mkdir(join(workspace, ".sofia", "tools"), { recursive: true });
    await mkdir(join(workspace, ".sofia", "plugins"), { recursive: true });
    await writeFile(join(workspace, ".sofia", "tools", "existing.ts"), "old tool\n", "utf8");
    await writeFile(join(workspace, ".sofia", "plugins", "removed.ts"), "removed plugin\n", "utf8");

    const preview = await buildWorkspaceImportPreview(workspace, {
      mode: { skills: "replace", commands: "replace", files: "replace" },
      sofia: {
        blueprint: {
          materialized: {
            sessions: { items: [{ templateId: "old", sessionId: "ses_123" }] },
          },
        },
      },
      skills: [
        { name: "demo", description: "Demo skill", content: "---\nname: demo\ndescription: Demo skill\n---\nupdated\n" },
        { name: "new-skill", description: "New skill", content: "---\nname: new-skill\ndescription: New skill\n---\nbody\n" },
      ],
      commands: [
        { content: "---\nname: old\ndescription: Old command\n---\nupdated command\n" },
        { name: "new-command", template: "run new command" },
      ],
      files: [
        { path: ".sofia/tools/existing.ts", content: "new tool\n" },
        { path: ".sofia/agents/new.md", content: "new agent\n" },
      ],
    });

    expect(preview.summary).toEqual({
      total: 8,
      create: 3,
      update: 4,
      replace: 0,
      delete: 1,
      unchanged: 0,
    });
    expect(preview.changes.map((change) => [change.kind, change.action, change.path])).toEqual([
      ["sofia", "update", "sofia-workspace-config"],
      ["skill", "update", ".sofia/skills/demo/SKILL.md"],
      ["skill", "create", ".sofia/skills/new-skill/SKILL.md"],
      ["command", "update", ".sofia/commands/old.md"],
      ["command", "create", ".sofia/commands/new-command.md"],
      ["file", "update", ".sofia/tools/existing.ts"],
      ["file", "create", ".sofia/agents/new.md"],
      ["file", "delete", ".sofia/plugins/removed.ts"],
    ]);

    expect(await readFile(join(workspace, ".sofia", "tools", "existing.ts"), "utf8")).toBe("old tool\n");
  });

  test("marks identical skills and commands unchanged", async () => {
    const workspace = await makeWorkspace();
    const skill = {
      name: "demo",
      description: "Demo skill",
      content: "---\nname: demo\ndescription: Demo skill\n---\nbody\n",
    };
    const command = {
      name: "demo-command",
      description: "Demo command",
      template: "do the thing",
    };
    const skillContent = buildSkillContent(skill);
    const commandContent = buildCommandContent(command);
    await mkdir(join(workspace, ".sofia", "skills", "demo"), { recursive: true });
    await mkdir(join(workspace, ".sofia", "commands"), { recursive: true });
    await writeFile(join(workspace, ".sofia", "skills", "demo", "SKILL.md"), skillContent.content, "utf8");
    await writeFile(join(workspace, ".sofia", "commands", "demo-command.md"), commandContent.content, "utf8");

    const preview = await buildWorkspaceImportPreview(workspace, {
      skills: [skill],
      commands: [command],
    });

    expect(preview.changes.map((change) => [change.kind, change.action, change.path])).toEqual([
      ["skill", "unchanged", ".sofia/skills/demo/SKILL.md"],
      ["command", "unchanged", ".sofia/commands/demo-command.md"],
    ]);
    expect(workspaceImportPreviewApprovalPaths(preview)).toEqual([]);
    expect(publicWorkspaceImportPreview(preview).changes[0]).not.toHaveProperty("absolutePath");
    expect(publicWorkspaceImportPreview(preview).changes[0]).not.toHaveProperty("beforeDigest");
  });

  test("uses replace action for config replacement", async () => {
    const workspace = await makeWorkspace();
    await writeFile(join(workspace, "engine.jsonc"), '{ "plugin": ["old"] }\n', "utf8");

    const preview = await buildWorkspaceImportPreview(workspace, {
      mode: { sofia: "replace" },
      sofia: { version: 2 },
    });

    expect(preview.changes[0]).toMatchObject({
      kind: "sofia",
      action: "replace",
      path: "sofia-workspace-config",
    });
    expect(summarizeWorkspaceImportPreview(preview)).toBe("Import workspace config (update 1)");
    expect(summarizeWorkspaceImportApplied(preview)).toBe("Imported workspace config (update 1)");
  });

  test("rejects unsafe portable file paths before import", async () => {
    const workspace = await makeWorkspace();

    await expect(
      buildWorkspaceImportPreview(workspace, {
        files: [{ path: ".sofia/.env", content: "SECRET=value\n" }],
      }),
    ).rejects.toThrow(/Portable file path is not allowed/i);
  });

  test("replace preview treats empty sections as delete all", async () => {
    const workspace = await makeWorkspace();
    await mkdir(join(workspace, ".sofia", "skills", "old-skill"), { recursive: true });
    await mkdir(join(workspace, ".sofia", "commands"), { recursive: true });
    await mkdir(join(workspace, ".sofia", "agents"), { recursive: true });
    await writeFile(join(workspace, ".sofia", "skills", "old-skill", "SKILL.md"), "old skill\n", "utf8");
    await writeFile(join(workspace, ".sofia", "commands", "old-command.md"), "old command\n", "utf8");
    await writeFile(join(workspace, ".sofia", "agents", "old.md"), "old agent\n", "utf8");

    const preview = await buildWorkspaceImportPreview(workspace, {
      mode: { skills: "replace", commands: "replace", files: "replace" },
      skills: [],
      commands: [],
      files: [],
    });

    expect(preview.summary).toMatchObject({
      total: 3,
      delete: 3,
    });
    expect(preview.changes.map((change) => [change.kind, change.action, change.path])).toEqual([
      ["skill", "delete", ".sofia/skills/old-skill"],
      ["command", "delete", ".sofia/commands/old-command.md"],
      ["file", "delete", ".sofia/agents/old.md"],
    ]);
  });

  test("preview route returns public changes and no-op import does not audit", async () => {
    const workspace = await makeWorkspace();
    const dataDir = await mkdtemp(join(tmpdir(), "sofia-import-preview-data-"));
    tempDirs.push(dataDir);
    await writeFile(join(workspace, "engine.jsonc"), '{ "plugin": ["demo"] }\n', "utf8");

    const originalDataDir = process.env.SOFIA_DATA_DIR;
    process.env.SOFIA_DATA_DIR = dataDir;
    const server = await startServer(makeServerConfig(workspace, dataDir)) as {
      port: number;
      stop: (force?: boolean) => void;
    };
    try {
      const baseUrl = `http://127.0.0.1:${server.port}`;
      const headers = {
        Authorization: "Bearer test-token",
        "Content-Type": "application/json",
      };
      const body = JSON.stringify({ sofia: { version: 2 } });

      const previewResponse = await fetch(`${baseUrl}/workspace/workspace/import/preview`, {
        method: "POST",
        headers,
        body,
      });
      expect(previewResponse.status).toBe(200);
      const preview = await previewResponse.json() as Record<string, unknown>;
      expect(typeof preview.fingerprint).toBe("string");
      expect((preview.changes as Array<Record<string, unknown>>)[0]).not.toHaveProperty("absolutePath");
      expect((preview.changes as Array<Record<string, unknown>>)[0]).not.toHaveProperty("beforeDigest");

      const unreviewedImport = await fetch(`${baseUrl}/workspace/workspace/import`, {
        method: "POST",
        headers,
        body,
      });
      expect(unreviewedImport.status).toBe(409);
      expect(await pathExists(auditLogPath("workspace"))).toBe(false);
    } finally {
      server.stop(true);
      if (originalDataDir === undefined) {
        delete process.env.SOFIA_DATA_DIR;
      } else {
        process.env.SOFIA_DATA_DIR = originalDataDir;
      }
    }
  });

  test("no-op import validates preview fingerprint shape", async () => {
    const workspace = await makeWorkspace();
    const dataDir = await mkdtemp(join(tmpdir(), "sofia-import-preview-data-"));
    tempDirs.push(dataDir);
    await writeFile(join(workspace, "engine.jsonc"), '{ "plugin": ["demo"] }\n', "utf8");

    const originalDataDir = process.env.SOFIA_DATA_DIR;
    process.env.SOFIA_DATA_DIR = dataDir;
    const server = await startServer(makeServerConfig(workspace, dataDir)) as {
      port: number;
      stop: (force?: boolean) => void;
    };
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/workspace/workspace/import`, {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          sofia: { version: 2 },
          previewFingerprint: 123,
        }),
      });

      expect(response.status).toBe(400);
      const body = await response.json() as { code: string };
      expect(body.code).toBe("invalid_workspace_import_preview_fingerprint");
      expect(await pathExists(auditLogPath("workspace"))).toBe(false);
    } finally {
      server.stop(true);
      if (originalDataDir === undefined) {
        delete process.env.SOFIA_DATA_DIR;
      } else {
        process.env.SOFIA_DATA_DIR = originalDataDir;
      }
    }
  });

  test("changed import requires a reviewed preview fingerprint", async () => {
    const workspace = await makeWorkspace();
    const dataDir = await mkdtemp(join(tmpdir(), "sofia-import-preview-data-"));
    tempDirs.push(dataDir);

    const originalDataDir = process.env.SOFIA_DATA_DIR;
    process.env.SOFIA_DATA_DIR = dataDir;
    const server = await startServer(makeServerConfig(workspace, dataDir)) as {
      port: number;
      stop: (force?: boolean) => void;
    };
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/workspace/workspace/import`, {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          sofia: { version: 2 },
        }),
      });

      expect(response.status).toBe(409);
      const body = await response.json() as {
        code: string;
        preview: { fingerprint: string; summary: { create: number; update: number } };
      };
      expect(body.code).toBe("workspace_import_preview_required");
      expect(typeof body.preview.fingerprint).toBe("string");
      expect(body.preview.summary.update).toBe(1);
      expect(await pathExists(join(workspace, "engine.jsonc"))).toBe(false);
      expect(await pathExists(auditLogPath("workspace"))).toBe(false);
    } finally {
      server.stop(true);
      if (originalDataDir === undefined) {
        delete process.env.SOFIA_DATA_DIR;
      } else {
        process.env.SOFIA_DATA_DIR = originalDataDir;
      }
    }
  });

  test("import route writes changed items and records audit", async () => {
    const workspace = await makeWorkspace();
    const dataDir = await mkdtemp(join(tmpdir(), "sofia-import-preview-data-"));
    tempDirs.push(dataDir);

    const originalDataDir = process.env.SOFIA_DATA_DIR;
    process.env.SOFIA_DATA_DIR = dataDir;
    const server = await startServer(makeServerConfig(workspace, dataDir)) as {
      port: number;
      stop: (force?: boolean) => void;
    };
    try {
      const baseUrl = `http://127.0.0.1:${server.port}`;
      const headers = {
        Authorization: "Bearer test-token",
        "Content-Type": "application/json",
      };
      const response = await requestWorkspaceImportWithPreview(baseUrl, headers, {
        sofia: { version: 2 },
        skills: [
          {
            name: "demo",
            description: "Demo skill",
            content: "Use this skill for demo work.",
          },
        ],
        files: [{ path: ".sofia/agents/demo.md", content: "Demo agent\n" }],
      });

      expect(response.status).toBe(200);
      const body = await response.json() as { preview: { summary: { create: number } } };
      expect(body.preview.summary.create).toBe(2);
      expect(await readFile(join(workspace, ".sofia", "skills", "demo", "SKILL.md"), "utf8")).toContain("Demo skill");
      expect(await readFile(join(workspace, ".sofia", "agents", "demo.md"), "utf8")).toBe("Demo agent\n");
      expect(await readFile(auditLogPath("workspace"), "utf8")).toContain("Imported workspace config");
    } finally {
      server.stop(true);
      if (originalDataDir === undefined) {
        delete process.env.SOFIA_DATA_DIR;
      } else {
        process.env.SOFIA_DATA_DIR = originalDataDir;
      }
    }
  });

  test("replace import route removes extra skills, commands, and portable files", async () => {
    const workspace = await makeWorkspace();
    const dataDir = await mkdtemp(join(tmpdir(), "sofia-import-preview-data-"));
    tempDirs.push(dataDir);

    const keepSkill = {
      name: "keep",
      description: "Keep skill",
      content: "Use this skill for stable setup.",
    };
    const keepCommand = {
      name: "keep-command",
      description: "Keep command",
      template: "run stable setup",
    };
    const keepSkillContent = buildSkillContent(keepSkill).content;
    const keepCommandContent = buildCommandContent(keepCommand).content;

    await mkdir(join(workspace, ".sofia", "skills", "keep"), { recursive: true });
    await mkdir(join(workspace, ".sofia", "skills", "remove-me"), { recursive: true });
    await mkdir(join(workspace, ".sofia", "commands"), { recursive: true });
    await mkdir(join(workspace, ".sofia", "tools"), { recursive: true });
    await writeFile(join(workspace, ".sofia", "skills", "keep", "SKILL.md"), keepSkillContent, "utf8");
    await writeFile(join(workspace, ".sofia", "skills", "remove-me", "SKILL.md"), "legacy skill\n", "utf8");
    await writeFile(join(workspace, ".sofia", "commands", "keep-command.md"), keepCommandContent, "utf8");
    await writeFile(join(workspace, ".sofia", "commands", "remove-me.md"), "legacy command\n", "utf8");
    await writeFile(join(workspace, ".sofia", "tools", "shared.ts"), "shared tool\n", "utf8");
    await writeFile(join(workspace, ".sofia", "tools", "remove-me.ts"), "legacy tool\n", "utf8");

    const originalDataDir = process.env.SOFIA_DATA_DIR;
    process.env.SOFIA_DATA_DIR = dataDir;
    const server = await startServer(makeServerConfig(workspace, dataDir)) as {
      port: number;
      stop: (force?: boolean) => void;
    };
    try {
      const baseUrl = `http://127.0.0.1:${server.port}`;
      const headers = {
        Authorization: "Bearer test-token",
        "Content-Type": "application/json",
      };
      const response = await requestWorkspaceImportWithPreview(baseUrl, headers, {
        mode: { skills: "replace", commands: "replace", files: "replace" },
        skills: [keepSkill],
        commands: [keepCommand],
        files: [{ path: ".sofia/tools/shared.ts", content: "shared tool\n" }],
      });

      expect(response.status).toBe(200);
      const body = await response.json() as {
        preview: { summary: { delete: number; unchanged: number } };
      };
      expect(body.preview.summary.delete).toBe(3);
      expect(body.preview.summary.unchanged).toBe(3);
      expect(await pathExists(join(workspace, ".sofia", "skills", "remove-me"))).toBe(false);
      expect(await pathExists(join(workspace, ".sofia", "commands", "remove-me.md"))).toBe(false);
      expect(await pathExists(join(workspace, ".sofia", "tools", "remove-me.ts"))).toBe(false);
      expect(await readFile(join(workspace, ".sofia", "skills", "keep", "SKILL.md"), "utf8")).toBe(keepSkillContent);
      expect(await readFile(join(workspace, ".sofia", "commands", "keep-command.md"), "utf8")).toBe(keepCommandContent);
      expect(await readFile(join(workspace, ".sofia", "tools", "shared.ts"), "utf8")).toBe("shared tool\n");
      expect(await readFile(auditLogPath("workspace"), "utf8")).toContain("Imported workspace config (remove 3)");
    } finally {
      server.stop(true);
      if (originalDataDir === undefined) {
        delete process.env.SOFIA_DATA_DIR;
      } else {
        process.env.SOFIA_DATA_DIR = originalDataDir;
      }
    }
  });

  test("replace import route honors empty sections", async () => {
    const workspace = await makeWorkspace();
    const dataDir = await mkdtemp(join(tmpdir(), "sofia-import-preview-data-"));
    tempDirs.push(dataDir);

    await mkdir(join(workspace, ".sofia", "skills", "old-skill"), { recursive: true });
    await mkdir(join(workspace, ".sofia", "commands"), { recursive: true });
    await mkdir(join(workspace, ".sofia", "agents"), { recursive: true });
    await writeFile(join(workspace, ".sofia", "skills", "old-skill", "SKILL.md"), "old skill\n", "utf8");
    await writeFile(join(workspace, ".sofia", "commands", "old-command.md"), "old command\n", "utf8");
    await writeFile(join(workspace, ".sofia", "agents", "old.md"), "old agent\n", "utf8");

    const originalDataDir = process.env.SOFIA_DATA_DIR;
    process.env.SOFIA_DATA_DIR = dataDir;
    const server = await startServer(makeServerConfig(workspace, dataDir)) as {
      port: number;
      stop: (force?: boolean) => void;
    };
    try {
      const baseUrl = `http://127.0.0.1:${server.port}`;
      const headers = {
        Authorization: "Bearer test-token",
        "Content-Type": "application/json",
      };
      const response = await requestWorkspaceImportWithPreview(baseUrl, headers, {
        mode: { skills: "replace", commands: "replace", files: "replace" },
        skills: [],
        commands: [],
        files: [],
      });

      expect(response.status).toBe(200);
      const body = await response.json() as {
        preview: { summary: { delete: number } };
      };
      expect(body.preview.summary.delete).toBe(3);
      expect(await pathExists(join(workspace, ".sofia", "skills", "old-skill"))).toBe(false);
      expect(await pathExists(join(workspace, ".sofia", "commands", "old-command.md"))).toBe(false);
      expect(await pathExists(join(workspace, ".sofia", "agents", "old.md"))).toBe(false);
    } finally {
      server.stop(true);
      if (originalDataDir === undefined) {
        delete process.env.SOFIA_DATA_DIR;
      } else {
        process.env.SOFIA_DATA_DIR = originalDataDir;
      }
    }
  });

  test("import route rejects a stale reviewed preview", async () => {
    const workspace = await makeWorkspace();
    const dataDir = await mkdtemp(join(tmpdir(), "sofia-import-preview-data-"));
    tempDirs.push(dataDir);
    await writeFile(join(workspace, "engine.jsonc"), '{ "plugin": ["old"] }\n', "utf8");

    const originalDataDir = process.env.SOFIA_DATA_DIR;
    process.env.SOFIA_DATA_DIR = dataDir;
    const server = await startServer(makeServerConfig(workspace, dataDir)) as {
      port: number;
      stop: (force?: boolean) => void;
    };
    try {
      const baseUrl = `http://127.0.0.1:${server.port}`;
      const headers = {
        Authorization: "Bearer test-token",
        "Content-Type": "application/json",
      };
      const payload = {
        mode: { skills: "replace" },
        skills: [{ name: "demo", description: "Demo skill", content: "---\nname: demo\ndescription: Demo skill\n---\nbody\n" }],
      };

      const previewResponse = await fetch(`${baseUrl}/workspace/workspace/import/preview`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
      expect(previewResponse.status).toBe(200);
      const preview = await previewResponse.json() as { fingerprint: string };

      await mkdir(join(workspace, ".sofia", "skills", "added-after-preview"), { recursive: true });
      await writeFile(join(workspace, ".sofia", "skills", "added-after-preview", "SKILL.md"), "added after preview\n", "utf8");

      const importResponse = await fetch(`${baseUrl}/workspace/workspace/import`, {
        method: "POST",
        headers,
        body: JSON.stringify({ ...payload, previewFingerprint: preview.fingerprint }),
      });
      expect(importResponse.status).toBe(409);
      const rejected = await importResponse.json() as {
        code: string;
        preview: { fingerprint: string };
      };
      expect(rejected.code).toBe("workspace_import_preview_stale");
      expect(rejected.preview.fingerprint).not.toBe(preview.fingerprint);
      expect(await readFile(join(workspace, ".sofia", "skills", "added-after-preview", "SKILL.md"), "utf8")).toContain("added after preview");
      expect(await pathExists(auditLogPath("workspace"))).toBe(false);
    } finally {
      server.stop(true);
      if (originalDataDir === undefined) {
        delete process.env.SOFIA_DATA_DIR;
      } else {
        process.env.SOFIA_DATA_DIR = originalDataDir;
      }
    }
  });

  test("import route revalidates the preview after approval", async () => {
    const workspace = await makeWorkspace();
    const dataDir = await mkdtemp(join(tmpdir(), "sofia-import-preview-data-"));
    tempDirs.push(dataDir);
    await writeFile(join(workspace, "engine.jsonc"), '{ "plugin": ["old"] }\n', "utf8");

    const originalDataDir = process.env.SOFIA_DATA_DIR;
    process.env.SOFIA_DATA_DIR = dataDir;
    const serverConfig = makeServerConfig(workspace, dataDir);
    serverConfig.approval = { mode: "ask", timeoutMs: 5000 };
    const server = await startServer(serverConfig) as {
      port: number;
      stop: (force?: boolean) => void;
    };
    try {
      const baseUrl = `http://127.0.0.1:${server.port}`;
      const headers = {
        Authorization: "Bearer test-token",
        "Content-Type": "application/json",
      };
      const payload = {
        mode: { skills: "replace" },
        skills: [{ name: "demo", description: "Demo skill", content: "---\nname: demo\ndescription: Demo skill\n---\nbody\n" }],
      };
      const preview = await requestWorkspaceImportPreview(baseUrl, headers, payload);

      const importPromise = fetch(`${baseUrl}/workspace/workspace/import`, {
        method: "POST",
        headers,
        body: JSON.stringify({ ...payload, previewFingerprint: preview.fingerprint }),
      });

      const approvalId = await waitForPendingApproval(baseUrl);
      await mkdir(join(workspace, ".sofia", "skills", "added-during-approval"), { recursive: true });
      await writeFile(join(workspace, ".sofia", "skills", "added-during-approval", "SKILL.md"), "added during approval\n", "utf8");
      const approvalResponse = await fetch(`${baseUrl}/approvals/${approvalId}`, {
        method: "POST",
        headers: {
          "X-Sofia-Host-Token": "host-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ reply: "allow" }),
      });
      expect(approvalResponse.status).toBe(200);

      const importResponse = await importPromise;
      expect(importResponse.status).toBe(409);
      const rejected = await importResponse.json() as {
        code: string;
        preview: { fingerprint: string };
      };
      expect(rejected.code).toBe("workspace_import_preview_stale");
      expect(rejected.preview.fingerprint).not.toBe(preview.fingerprint);
      expect(await readFile(join(workspace, ".sofia", "skills", "added-during-approval", "SKILL.md"), "utf8")).toContain("added during approval");
      expect(await pathExists(auditLogPath("workspace"))).toBe(false);
    } finally {
      server.stop(true);
      if (originalDataDir === undefined) {
        delete process.env.SOFIA_DATA_DIR;
      } else {
        process.env.SOFIA_DATA_DIR = originalDataDir;
      }
    }
  });

  test("import route validates preview fingerprint shape", async () => {
    const workspace = await makeWorkspace();
    const dataDir = await mkdtemp(join(tmpdir(), "sofia-import-preview-data-"));
    tempDirs.push(dataDir);

    const originalDataDir = process.env.SOFIA_DATA_DIR;
    process.env.SOFIA_DATA_DIR = dataDir;
    const server = await startServer(makeServerConfig(workspace, dataDir)) as {
      port: number;
      stop: (force?: boolean) => void;
    };
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/workspace/workspace/import`, {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          sofia: { version: 2 },
          previewFingerprint: 123,
        }),
      });

      expect(response.status).toBe(400);
      const body = await response.json() as { code: string };
      expect(body.code).toBe("invalid_workspace_import_preview_fingerprint");
    } finally {
      server.stop(true);
      if (originalDataDir === undefined) {
        delete process.env.SOFIA_DATA_DIR;
      } else {
        process.env.SOFIA_DATA_DIR = originalDataDir;
      }
    }
  });

  test("replace import keeps existing items when an incoming write fails", async () => {
    const workspace = await makeWorkspace();
    const dataDir = await mkdtemp(join(tmpdir(), "sofia-import-preview-data-"));
    tempDirs.push(dataDir);

    await mkdir(join(workspace, ".sofia", "skills", "old"), { recursive: true });
    await writeFile(join(workspace, ".sofia", "skills", "old", "SKILL.md"), "old skill\n", "utf8");
    await writeFile(join(workspace, ".sofia", "skills", "new"), "blocks new skill directory\n", "utf8");

    const originalDataDir = process.env.SOFIA_DATA_DIR;
    process.env.SOFIA_DATA_DIR = dataDir;
    const server = await startServer(makeServerConfig(workspace, dataDir)) as {
      port: number;
      stop: (force?: boolean) => void;
    };
    try {
      const baseUrl = `http://127.0.0.1:${server.port}`;
      const headers = {
        Authorization: "Bearer test-token",
        "Content-Type": "application/json",
      };
      const response = await silenceExpectedServerError(() =>
        requestWorkspaceImportWithPreview(baseUrl, headers, {
          mode: { skills: "replace" },
          skills: [
            {
              name: "new",
              description: "New skill",
              content: "new skill\n",
            },
          ],
        }),
      );

      expect(response.ok).toBe(false);
      expect(response.status).toBe(500);
      expect(await readFile(join(workspace, ".sofia", "skills", "old", "SKILL.md"), "utf8")).toBe("old skill\n");
      expect(await readFile(join(workspace, ".sofia", "skills", "new"), "utf8")).toBe(
        "blocks new skill directory\n",
      );
    } finally {
      server.stop(true);
      if (originalDataDir === undefined) {
        delete process.env.SOFIA_DATA_DIR;
      } else {
        process.env.SOFIA_DATA_DIR = originalDataDir;
      }
    }
  });
});
