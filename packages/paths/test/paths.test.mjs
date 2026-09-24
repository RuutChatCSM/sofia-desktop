import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  desktopBootstrapPath,
  globalWorkspaceEngineConfigDir,
  legacyDesktopBootstrapPath,
  MAX_CONFIG_ROOT_LENGTH,
  normalizeWorkspaceRootPath,
  sofiaEnvStorePath,
  sofiaServerConfigPath,
  resolveGlobalWorkspaceEngineConfigPath,
  resolveWorkspaceWorkspaceEngineConfigPath,
  workspaceWorkspaceEngineConfigCandidates,
} from "../index.mjs";

async function withTempDir(callback) {
  const root = await mkdtemp(path.join(tmpdir(), "sofia-paths-"));
  try {
    await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("workspace root paths", () => {
  test("normalizes valid Windows verbatim drive and UNC paths cross-platform", () => {
    const opts = { platform: "win32" };
    expect(normalizeWorkspaceRootPath("\\\\?\\C:\\Users\\Ada\\Workspace", opts))
      .toBe("C:\\Users\\Ada\\Workspace");
    expect(normalizeWorkspaceRootPath("\\\\?\\C:\\", opts)).toBe("C:\\");
    expect(normalizeWorkspaceRootPath("//?/UNC/server/share/Workspace", opts))
      .toBe("\\\\server\\share\\Workspace");
    expect(normalizeWorkspaceRootPath("\\\\?\\UNC\\server\\share", opts))
      .toBe("\\\\server\\share");
  });

  test("preserves valid normal drives and UNC shares without checking availability", () => {
    const opts = { platform: "win32" };
    expect(normalizeWorkspaceRootPath("Z:\\Disconnected\\Workspace", opts))
      .toBe("Z:\\Disconnected\\Workspace");
    expect(normalizeWorkspaceRootPath("\\\\offline-server\\share\\Workspace", opts))
      .toBe("\\\\offline-server\\share\\Workspace");
    expect(normalizeWorkspaceRootPath("\\\\offline-server\\pipe\\Workspace", opts))
      .toBe("\\\\offline-server\\pipe\\Workspace");
  });

  test("rejects Win32 device namespace roots", () => {
    const opts = { platform: "win32" };
    for (const value of [
      "\\\\.\\pipe\\sofia",
      "//./PIPE/sofia",
      "\\\\.\\PhysicalDrive0",
      "\\\\?\\UNC\\.\\pipe\\sofia",
      "\\\\?\\UNC\\?\\PhysicalDrive0",
    ]) {
      expect(() => normalizeWorkspaceRootPath(value, opts)).toThrow("Invalid Windows workspace root");
    }
  });

  test("rejects incomplete Windows drive and UNC roots", () => {
    const opts = { platform: "win32" };
    for (const value of [
      "C:",
      "\\\\?\\",
      "\\\\?\\C:",
      "\\\\?\\C:Workspace",
      "\\\\?\\UNC",
      "\\\\?\\UNC\\server",
      "\\\\server",
    ]) {
      expect(() => normalizeWorkspaceRootPath(value, opts)).toThrow("Invalid Windows workspace root");
    }
  });

  test("applies Windows validation only when Windows is injected", () => {
    expect(normalizeWorkspaceRootPath("\\\\?\\C:", { platform: "linux" })).toBe("\\\\?\\C:");
  });
});

describe("sofia server config paths", () => {
  test("uses APPDATA on Windows", () => {
    expect(sofiaServerConfigPath({
      env: { APPDATA: "C:\\Users\\Ada\\AppData\\Roaming" },
      homeDir: "C:\\Users\\Ada",
      platform: "win32",
    })).toBe("C:\\Users\\Ada\\AppData\\Roaming\\sofia\\server.json");
  });

  test("uses XDG_CONFIG_HOME on Unix", () => {
    expect(sofiaServerConfigPath({
      env: { XDG_CONFIG_HOME: "/tmp/xdg" },
      homeDir: "/home/ada",
      platform: "linux",
    })).toBe("/tmp/xdg/sofia/server.json");
  });

  test("falls back to ~/.config", () => {
    expect(sofiaServerConfigPath({ env: {}, homeDir: "/home/ada", platform: "linux" }))
      .toBe("/home/ada/.config/sofia/server.json");
  });

  test("honors SOFIA_SERVER_CONFIG", () => {
    expect(sofiaServerConfigPath({
      env: { SOFIA_SERVER_CONFIG: "/tmp/sofia/server.json" },
      homeDir: "/home/ada",
      platform: "linux",
    })).toBe("/tmp/sofia/server.json");
  });
});

describe("sofia env store and desktop bootstrap paths", () => {
  test("honors SOFIA_ENV_STORE", () => {
    expect(sofiaEnvStorePath({
      env: { SOFIA_ENV_STORE: "/tmp/sofia/env.json" },
      homeDir: "/home/ada",
      platform: "linux",
    })).toBe("/tmp/sofia/env.json");
  });

  test("uses the same sofia config layout for env.json", () => {
    expect(sofiaEnvStorePath({
      env: { XDG_CONFIG_HOME: "/tmp/xdg" },
      homeDir: "/home/ada",
      platform: "linux",
    })).toBe("/tmp/xdg/sofia/env.json");
  });

  test("honors SOFIA_DESKTOP_BOOTSTRAP_PATH", () => {
    expect(desktopBootstrapPath({
      env: { SOFIA_DESKTOP_BOOTSTRAP_PATH: "/tmp/bootstrap.json" },
      homeDir: "/home/ada",
      platform: "linux",
    })).toBe("/tmp/bootstrap.json");
  });

  test("preserves dev-data desktop bootstrap path when userDataDir is injected", () => {
    expect(desktopBootstrapPath({
      env: { SOFIA_DEV_MODE: "1" },
      homeDir: "/Users/ada",
      platform: "darwin",
      userDataDir: "/tmp/sofia-userdata",
    })).toBe("/tmp/sofia-userdata/sofia-dev-data/home/.config/sofia/desktop-bootstrap.json");
  });

  test("resolves the legacy desktop bootstrap path from the chosen home", () => {
    expect(legacyDesktopBootstrapPath({ env: {}, homeDir: "/Users/ada", platform: "darwin" }))
      .toBe("/Users/ada/.config/sofia/desktop-bootstrap.json");
  });
});

describe("global Sofia config paths", () => {
  test("accepts safe SOFIA_ENGINE_CONFIG_DIR as the config directory", async () => {
    await withTempDir(async (root) => {
      const engineConfigDir = path.join(root, "explicit-engine");
      await mkdir(engineConfigDir, { recursive: true });
      const json = path.join(engineConfigDir, "engine.json");
      await writeFile(json, "{}", "utf8");

      const opts = {
        env: { SOFIA_ENGINE_CONFIG_DIR: engineConfigDir, XDG_CONFIG_HOME: path.join(root, "xdg") },
        homeDir: path.join(root, "home"),
        platform: "linux",
      };
      expect(globalWorkspaceEngineConfigDir(opts)).toBe(engineConfigDir);
      expect(resolveGlobalWorkspaceEngineConfigPath(opts)).toBe(json);
    });
  });

  test("prefers engine.jsonc over engine.json and falls back to jsonc", async () => {
    await withTempDir(async (root) => {
      const dir = path.join(root, "xdg", "engine");
      await mkdir(dir, { recursive: true });
      const opts = { env: { XDG_CONFIG_HOME: path.join(root, "xdg") }, homeDir: path.join(root, "home"), platform: "linux" };
      const jsonc = path.join(dir, "engine.jsonc");
      const json = path.join(dir, "engine.json");

      expect(resolveGlobalWorkspaceEngineConfigPath(opts)).toBe(jsonc);
      await writeFile(json, "{}", "utf8");
      expect(resolveGlobalWorkspaceEngineConfigPath(opts)).toBe(json);
      await writeFile(jsonc, "{}", "utf8");
      expect(resolveGlobalWorkspaceEngineConfigPath(opts)).toBe(jsonc);
    });
  });

  test("rejects relative SOFIA_ENGINE_CONFIG_DIR", () => {
    const opts = {
      env: { SOFIA_ENGINE_CONFIG_DIR: "relative/engine", XDG_CONFIG_HOME: "/tmp/xdg" },
      homeDir: "/home/ada",
      platform: "linux",
    };
    expect(globalWorkspaceEngineConfigDir(opts)).toBe("/tmp/xdg/engine");
  });

  test("rejects over-long SOFIA_ENGINE_CONFIG_DIR", () => {
    const opts = {
      env: { SOFIA_ENGINE_CONFIG_DIR: `/${"a".repeat(MAX_CONFIG_ROOT_LENGTH)}`, XDG_CONFIG_HOME: "/tmp/xdg" },
      homeDir: "/home/ada",
      platform: "linux",
    };
    expect(globalWorkspaceEngineConfigDir(opts)).toBe("/tmp/xdg/engine");
  });

  test("rejects forbidden control characters in SOFIA_ENGINE_CONFIG_DIR", () => {
    const opts = {
      env: { SOFIA_ENGINE_CONFIG_DIR: "/tmp/engine\n", XDG_CONFIG_HOME: "/tmp/xdg" },
      homeDir: "/home/ada",
      platform: "linux",
    };
    expect(globalWorkspaceEngineConfigDir(opts)).toBe("/tmp/xdg/engine");
  });
});

describe("workspace Sofia config paths", () => {
  test("returns the four server candidates in order", () => {
    expect(workspaceWorkspaceEngineConfigCandidates("/repo/workspace")).toEqual([
      "/repo/workspace/engine.jsonc",
      "/repo/workspace/engine.json",
      "/repo/workspace/.sofia/engine.jsonc",
      "/repo/workspace/.sofia/engine.json",
    ]);
  });

  test("resolves the first existing workspace candidate", async () => {
    await withTempDir(async (root) => {
      await mkdir(path.join(root, ".sofia"), { recursive: true });
      const hiddenJsonc = path.join(root, ".sofia", "engine.jsonc");
      const hiddenJson = path.join(root, ".sofia", "engine.json");
      await writeFile(hiddenJson, "{}", "utf8");
      expect(resolveWorkspaceWorkspaceEngineConfigPath(root)).toBe(hiddenJson);
      await writeFile(hiddenJsonc, "{}", "utf8");
      expect(resolveWorkspaceWorkspaceEngineConfigPath(root)).toBe(hiddenJsonc);
    });
  });
});
