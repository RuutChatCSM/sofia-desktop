import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { sofiaPluginPath } from "./sofia-extensions-plugin-path.js";

function withPluginDir(value: string | undefined, fn: () => void) {
  const previous = process.env.SOFIA_EXTENSIONS_PLUGIN_DIR;
  if (value === undefined) {
    delete process.env.SOFIA_EXTENSIONS_PLUGIN_DIR;
  } else {
    process.env.SOFIA_EXTENSIONS_PLUGIN_DIR = value;
  }

  try {
    fn();
  } finally {
    if (previous === undefined) {
      delete process.env.SOFIA_EXTENSIONS_PLUGIN_DIR;
    } else {
      process.env.SOFIA_EXTENSIONS_PLUGIN_DIR = previous;
    }
  }
}

function restoreResourcesPath(previous: string | undefined) {
  if (previous === undefined) {
    delete process.resourcesPath;
  } else {
    process.resourcesPath = previous;
  }
}

describe("sofiaPluginPath", () => {
  test("prefers SOFIA_EXTENSIONS_PLUGIN_DIR", () => {
    withPluginDir("/opt/sofia/engine-plugins", () => {
      const resourcesPath = join("/Applications", "Sofia App.app", "Contents", "Resources");
      const previousResourcesPath = process.resourcesPath;
      process.resourcesPath = resourcesPath;
      try {
        expect(sofiaPluginPath("sofia-extensions-preview", join(resourcesPath, "app.asar", "server", "dist")))
          .toBe(join("/opt/sofia/engine-plugins", "sofia-extensions-preview.js"));
      } finally {
        restoreResourcesPath(previousResourcesPath);
      }
    });
  });

  test("uses external resources plugin path in packaged Electron when env is unset", () => {
    withPluginDir(undefined, () => {
      const previousResourcesPath = process.resourcesPath;
      const resourcesPath = join("/Applications", "Sofia App.app", "Contents", "Resources");
      process.resourcesPath = resourcesPath;
      try {
        const pluginPath = sofiaPluginPath(
          "sofia-extensions-preview",
          join(resourcesPath, "app.asar", "server", "dist"),
        );

        expect(pluginPath).toBe(join(resourcesPath, "engine-plugins", "sofia-extensions-preview.js"));
        expect(pluginPath).not.toContain("app.asar");
      } finally {
        restoreResourcesPath(previousResourcesPath);
      }
    });
  });

  test("uses source plugin path in development when env is unset", () => {
    withPluginDir(undefined, () => {
      const here = join("/repo", "apps", "server", "src");
      expect(sofiaPluginPath("sofia-extensions-preview", here))
        .toBe(join(here, "engine-plugins", "sofia-extensions-preview.ts"));
    });
  });
});
