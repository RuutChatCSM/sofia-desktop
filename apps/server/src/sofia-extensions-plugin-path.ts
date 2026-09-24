import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

declare global {
  namespace NodeJS {
    interface Process {
      resourcesPath?: string;
    }
  }
}

function resourcesPathFromAppAsarPath(path: string): string | null {
  const match = /[\\/]app\.asar(?:[\\/]|$)/.exec(path);
  return match ? path.slice(0, match.index) : null;
}

export function sofiaPluginPath(name: string, here?: string): string {
  const pluginDir = process.env.SOFIA_EXTENSIONS_PLUGIN_DIR;
  if (pluginDir) {
    return join(pluginDir, `${name}.js`);
  }

  here = here ?? dirname(fileURLToPath(import.meta.url));
  const resourcesPath = resourcesPathFromAppAsarPath(here);
  if (resourcesPath) {
    const electronResourcesPath = process.resourcesPath?.includes("app.asar") ? resourcesPath : process.resourcesPath?.trim();
    return join(electronResourcesPath || resourcesPath, "engine-plugins", `${name}.js`);
  }

  const extension = basename(here) === "dist" ? "js" : "ts";
  return join(here, "engine-plugins", `${name}.${extension}`);
}

export const sofiaExtensionsPreviewPluginPath = () => sofiaPluginPath("sofia-extensions-preview");
export const sofiaCapabilitiesKnowledgePluginPath = () => sofiaPluginPath("sofia-capabilities-knowledge");
export const sofiaAnthropicAdaptiveThinkingPluginPath = () => sofiaPluginPath("sofia-anthropic-adaptive-thinking");
export const sofiaAnthropicToolSchemaPluginPath = () => sofiaPluginPath("sofia-anthropic-tool-schema");
export const sofiaOfficeAttachmentsPluginPath = () => sofiaPluginPath("sofia-office-attachments");
