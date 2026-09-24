import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listPortableFiles, planPortableFiles, writePortableFiles } from "./portable-files.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sofia-portable-files-"));
  tempDirs.push(dir);
  await mkdir(join(dir, ".sofia"), { recursive: true });
  return dir;
}

describe("portable files", () => {
  test("lists only extra shareable .sofia files", async () => {
    const workspaceRoot = await makeWorkspace();
    await mkdir(join(workspaceRoot, ".sofia", "agents"), { recursive: true });
    await mkdir(join(workspaceRoot, ".sofia", "plugins"), { recursive: true });
    await mkdir(join(workspaceRoot, ".sofia", "tools"), { recursive: true });
    await mkdir(join(workspaceRoot, ".sofia", "node_modules", "demo"), { recursive: true });
    await mkdir(join(workspaceRoot, ".sofia", "skills", "demo"), { recursive: true });
    await mkdir(join(workspaceRoot, ".sofia", "commands"), { recursive: true });

    await writeFile(join(workspaceRoot, ".sofia", "agents", "sofia.md"), "# agent\n", "utf8");
    await writeFile(join(workspaceRoot, ".sofia", "plugins", "router.json"), '{"enabled":true}\n', "utf8");
    await writeFile(join(workspaceRoot, ".sofia", "tools", "database.ts"), "export default {};\n", "utf8");
    await writeFile(join(workspaceRoot, ".sofia", "node_modules", "demo", "index.js"), "export default 1;\n", "utf8");
    await writeFile(join(workspaceRoot, ".sofia", "skills", "demo", "SKILL.md"), "# skill\n", "utf8");
    await writeFile(join(workspaceRoot, ".sofia", "commands", "demo.md"), "# command\n", "utf8");
    await writeFile(join(workspaceRoot, ".sofia", "sofia.json"), '{"version":1}\n', "utf8");
    await writeFile(join(workspaceRoot, ".sofia", "engine.db"), "sqlite-bytes", "utf8");
    await writeFile(join(workspaceRoot, ".sofia", ".env"), "SECRET=value\n", "utf8");

    const files = await listPortableFiles(workspaceRoot);

    expect(files).toEqual([
      { path: ".sofia/agents/sofia.md", content: "# agent\n" },
      { path: ".sofia/plugins/router.json", content: '{"enabled":true}\n' },
      { path: ".sofia/tools/database.ts", content: "export default {};\n" },
    ]);
  });

  test("plans and writes validated portable files", async () => {
    const workspaceRoot = await makeWorkspace();
    const planned = planPortableFiles(workspaceRoot, [
      { path: ".sofia/agents/demo.md", content: "hello\n" },
      { path: ".sofia/tools/demo.ts", content: "export default {};\n" },
    ]);

    expect(planned[0]?.absolutePath.endsWith("/.sofia/agents/demo.md")).toBe(true);
    expect(planned[1]?.absolutePath.endsWith("/.sofia/tools/demo.ts")).toBe(true);

    await writePortableFiles(workspaceRoot, [
      { path: ".sofia/agents/demo.md", content: "hello\n" },
      { path: ".sofia/tools/demo.ts", content: "export default {};\n" },
    ]);

    const contents = await readFile(join(workspaceRoot, ".sofia", "agents", "demo.md"), "utf8");
    const toolContents = await readFile(join(workspaceRoot, ".sofia", "tools", "demo.ts"), "utf8");
    expect(contents).toBe("hello\n");
    expect(toolContents).toBe("export default {};\n");
  });

  test("rejects non-allowlisted portable files and path traversal", async () => {
    const workspaceRoot = await makeWorkspace();

    expect(() =>
      planPortableFiles(workspaceRoot, [{ path: ".sofia/.env", content: "SECRET=value" }]),
    ).toThrow(/not allowed/i);

    expect(() =>
      planPortableFiles(workspaceRoot, [{ path: ".sofia/package.json", content: "{}" }]),
    ).toThrow(/not allowed/i);

    expect(() =>
      planPortableFiles(workspaceRoot, [{ path: ".sofia/sofia.json", content: "{}" }]),
    ).toThrow(/not allowed/i);

    expect(() =>
      planPortableFiles(workspaceRoot, [{ path: "../outside.md", content: "oops" }]),
    ).toThrow(/invalid/i);

    expect(() =>
      planPortableFiles(workspaceRoot, [{ path: ".sofia/node_modules/demo/index.js", content: "oops" }]),
    ).toThrow(/not allowed/i);
  });
});
