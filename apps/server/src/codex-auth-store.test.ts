// Tests for the codex auth store (codex-auth.json).
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "bun:test";

import {
  clearCodexAuthStore,
  readCodexAuthStore,
  removeCodexAuthKey,
  setCodexAuthKey,
  writeCodexAuthStore,
} from "./codex-auth-store.js";

let tempDirs: string[] = [];

async function tempFilePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "codex-auth-store-"));
  tempDirs.push(dir);
  return join(dir, "codex-auth.json");
}

afterEach(() => {
  tempDirs = [];
});

describe("codex auth store", () => {
  it("returns empty store when missing", async () => {
    expect(await readCodexAuthStore({ path: await tempFilePath() })).toEqual({});
  });

  it("sets and reads a key", async () => {
    const path = await tempFilePath();
    await setCodexAuthKey("deepseek", "DEEPSEEK_API_KEY", "sk-123", { path });
    const store = await readCodexAuthStore({ path });
    expect(store.DEEPSEEK_API_KEY).toBe("sk-123");
  });

  it("overwrites an existing key", async () => {
    const path = await tempFilePath();
    await setCodexAuthKey("deepseek", "DEEPSEEK_API_KEY", "sk-old", { path });
    await setCodexAuthKey("deepseek", "DEEPSEEK_API_KEY", "sk-new", { path });
    const store = await readCodexAuthStore({ path });
    expect(store.DEEPSEEK_API_KEY).toBe("sk-new");
  });

  it("removes a provider key", async () => {
    const path = await tempFilePath();
    await setCodexAuthKey("deepseek", "DEEPSEEK_API_KEY", "sk-123", { path });
    await clearCodexAuthStore({ path });
    expect(await readCodexAuthStore({ path })).toEqual({});
  });

  it("writes with 0600 permissions", async () => {
    const path = await tempFilePath();
    await writeCodexAuthStore({ DEEPSEEK_API_KEY: "sk-123" }, { path });
    const raw = JSON.parse(await readFile(path, "utf8"));
    expect(raw.DEEPSEEK_API_KEY).toBe("sk-123");
  });

  it("clears the store", async () => {
    const path = await tempFilePath();
    await setCodexAuthKey("deepseek", "DEEPSEEK_API_KEY", "sk-123", { path });
    await clearCodexAuthStore({ path });
    expect(await readCodexAuthStore({ path })).toEqual({});
  });
});
