import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { expect } from "vitest";
import { test } from "@sofia/testkit";

import { buildCodexConfigToml } from "../../apps/server/src/codex-config.ts";
import { buildSofiaDeveloperInstructions } from "../../apps/server/src/codex-prompt-harness.ts";
import { codexRuntimeSkill } from "../../apps/server/src/codex-runtime-mcp.ts";

const repoRoot = path.resolve(import.meta.dirname, "../..");

test("Sofia preserves native engine behavior while wiring multi-provider and browser capabilities", async () => {
  const context = buildSofiaDeveloperInstructions({ workspaceId: "workspace-1", cwd: "/repo" });
  expect(context).toContain("<sofia_context>");
  expect(context).not.toMatch(/Sofia App|Codex/);
  expect(context).toContain("Working directory: /repo");
  expect(context).not.toMatch(/make a short plan|execute it back-to-back|report the outcome in one line/i);

  const config = buildCodexConfigToml({
    openai: {
      name: "OpenAI",
      npm: "@ai-sdk/openai",
      api: "https://api.openai.com/v1",
      env: ["OPENAI_API_KEY"],
    },
    xiaomi: {
      name: "Xiaomi MiMo",
      npm: "@ai-sdk/openai-compatible",
      api: "https://api.xiaomimimo.com/v1",
      env: ["XIAOMI_API_KEY"],
    },
  });
  expect(config).toContain("[model_providers.openai]");
  expect(config).toContain("[model_providers.xiaomi]");
  expect(config).toMatch(/\[model_providers\.openai\][\s\S]*?wire_api = "responses"/);
  expect(config).toMatch(/\[model_providers\.xiaomi\][\s\S]*?wire_api = "chatcompletions"/);

  const browserSkill = codexRuntimeSkill("browser");
  expect(browserSkill).toContain("mcp__node_repl__js");
  expect(browserSkill).toContain("browser.documentation()");
  expect(browserSkill).toContain("take a fresh snapshot");

  const sourceAsset = path.join(repoRoot, "apps/server/src/sofia-browser-repl.mjs");
  await access(sourceAsset);
  const packageJson = JSON.parse(await readFile(path.join(repoRoot, "apps/server/package.json"), "utf8"));
  expect(packageJson.scripts.build).toContain("build:runtime-assets");
});
