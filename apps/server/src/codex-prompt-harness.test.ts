import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { buildSofiaDeveloperInstructions, readProjectInstructions } from "./codex-prompt-harness.js";

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
});

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "openwork-prompt-harness-"));
  roots.push(root);
  return root;
}

describe("codex-prompt-harness", () => {
  test("builds factual host context without overriding Codex behavior", () => {
    const instructions = buildSofiaDeveloperInstructions({
      workspaceId: "ws_1",
      cwd: "/repo",
    });
    expect(instructions).toContain("OpenWork is hosting this Codex engine");
    expect(instructions).toContain("Workspace id: ws_1");
    expect(instructions).toContain("Working directory: /repo");
    expect(instructions).not.toContain("Make a short plan");
    expect(instructions).not.toContain("EXECUTE it back-to-back");
  });

  test("reads AGENTS.md and prefers it over CLAUDE.md", async () => {
    const root = await createRoot();
    await writeFile(join(root, "CLAUDE.md"), "CLAUDE only");
    await writeFile(join(root, "AGENTS.md"), "AGENTS rules");
    expect(readProjectInstructions(root)).toBe("AGENTS rules");
  });

  test("reads CLAUDE.md when AGENTS.md is absent", async () => {
    const root = await createRoot();
    await writeFile(join(root, "CLAUDE.md"), "CLAUDE only");
    expect(readProjectInstructions(root)).toBe("CLAUDE only");
  });

  test("returns null when no instructions file exists", async () => {
    const root = await createRoot();
    expect(readProjectInstructions(root)).toBeNull();
  });
});
