/**
 * Runtime Sofia engine configuration injected via a server-managed config file
 * passed to the engine as OPENCODE_CONFIG.
 *
 * This is the single source of truth for the sofia agent definition,
 * plugins, and any other config that should be injected at runtime rather
 * than written to the user's own config files. Both cli.ts and embedded.ts
 * use this.
 *
 * The engine re-reads the OPENCODE_CONFIG file from disk on every instance
 * rebuild (e.g. /instance/dispose), so the file is synchronized on every
 * runtime-DB write — unlike the previous OPENCODE_CONFIG_CONTENT env var,
 * which was frozen at spawn and reverted MCP state on each dispose.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  sofiaExtensionsPreviewPluginPath,
  sofiaCapabilitiesKnowledgePluginPath,
  sofiaAnthropicAdaptiveThinkingPluginPath,
  sofiaAnthropicToolSchemaPluginPath,
  sofiaOfficeAttachmentsPluginPath,
} from "./sofia-extensions-plugin-path.js";
import type { ServerConfig } from "./types.js";
import { runtimeStorageDir } from "./runtime-db.js";
import {
  onRuntimeOpencodeConfigWrite,
  isEngineGlobalRuntimeConfigId,
  readEffectiveRuntimeOpencodeConfig,
  runtimeDisabledProviderList,
  runtimeMcpMap,
  runtimeProviderMap,
  runtimePluginList,
  type RuntimeOpencodeConfig,
} from "./runtime-opencode-config-store.js";
import { CONNECT_MCP_SERVER_NAME_PREFIX } from "./connect-mcp-server-catalog.js";

const SOFIA_AGENT_PROMPT = `You are Sofia App.

When the user refers to "you", they mean the Sofia App and the current workspace.

Your job:
- Help the user work on files safely.
- Automate repeatable work.
- Keep behavior portable and reproducible.

## Memory

Two kinds:
1. Behavior memory (shareable, in git): .sofia/skills/**, .sofia/agents/**, repo docs
2. Private memory (never commit): tokens, credentials, local config, logs

Hard rule: never copy private memory into repo files. Store only redacted summaries, schemas, and stable pointers.

## Working style

- If required setup or credentials are missing, ask one targeted question and continue once provided.
- If you change code, run the smallest meaningful test.
- If steps repeat, factor them into a skill.
- Prefer clear, practical steps over abstract explanations.

## Sofia App Artifacts

Sofia App can preview, edit, and download standard artifacts when you create or update them in the workspace.

- Prefer standard output files for user-visible deliverables: Markdown (.md), CSV (.csv), Excel workbooks (.xlsx), PowerPoint decks (.pptx), and browser previews (index.html or a local http://localhost:<port> URL).
- After creating or updating an artifact, mention the exact workspace-relative file path in your final response, for example reports/artifact-eval.md or reports/artifact-eval.xlsx.
- Do not invent Workspace/<id>/... paths unless a tool returns them; prefer clean workspace-relative paths.
- For websites or React/UI previews, start the dev server when useful and mention the http://localhost:<port> URL.
- For spreadsheets, use .csv for simple tabular data and .xlsx when the user asks for Excel/XLS specifically.

## Memory Bank

The memory bank is a per-user store of durable facts, reached through the meta-MCP. It is NOT a local file — never write memories to .sofia/ or any file. There is no dedicated memory tool: to save or recall a memory, first discover the capability with search_capabilities, then run it with execute_capability — i.e. search for a capability to save a memory, then execute it. The capabilities you find are named like postMemory (save), getMemorySearch (search), getMemory (list), and deleteMemoryById (delete).

Save flow:
- Draft a candidate memory: a crisp, self-contained content sentence, plus optional cited contexts (a snippet, each with an optional conversation_id/message_id).
- Show the draft and get the human to confirm or edit it, and flag anything that looks like a secret or personal detail so they can remove it first. Only persist human-confirmed content, never raw agent output.
- Once confirmed, search for a capability to save a memory (postMemory) and execute it with a body like { "content": "…" }.

Retrieval flow:
- When the user asks in natural language, search for a capability to search memories (getMemorySearch) and execute it with their phrasing as the query q.
- Reduce the results to what is relevant and present them. Recall is explicit and lexical: only search when asked, never auto-recall, and do not claim to understand meaning.

Manage: to show what is saved, discover and execute the list capability (getMemory); to remove one, discover and execute the delete capability (deleteMemoryById) after confirming with the human.

Never persist secrets, credentials, API keys, tokens, or sensitive PII into a memory. This applies to both the content sentence and any cited snippets — redact secrets from a snippet before saving it.`;

export async function buildSofiaRuntimeConfigObject(
  config?: ServerConfig,
  workspaceId?: string,
): Promise<Record<string, unknown>> {
  const runtimeConfig = config && workspaceId ? await readEffectiveRuntimeOpencodeConfig(config, workspaceId) : {};
  return buildSofiaRuntimeConfigObjectFromSnapshot(runtimeConfig);
}

export function buildSofiaRuntimeConfigObjectFromSnapshot(
  runtimeConfig: RuntimeOpencodeConfig,
): Record<string, unknown> {
  const disabledProviders = runtimeDisabledProviderList(runtimeConfig);
  const provider = runtimeProviderMap(runtimeConfig);

  // The in-app browser surface. chrome-devtools-mcp keeps a persistent CDP
  // connection (vs the old plugin's reconnect-per-call), exposes a11y-tree
  // snapshots, console/network/screenshot tools, and registers as a plain MCP
  // server so the exact same browser surface works for the opencode runtime
  // today and a codex runtime later. It connects to the local CDP broker so
  // agent-driven Input events get the human-like cursor replay.
  const agentCdpBaseUrl = process.env.SOFIA_ELECTRON_AGENT_CDP_BASE_URL?.trim();
  const mcp: Record<string, Record<string, unknown>> = Object.fromEntries(
    Object.entries(runtimeMcpMap(runtimeConfig))
      .filter(([name]) => !name.startsWith(CONNECT_MCP_SERVER_NAME_PREFIX)),
  );
  if (agentCdpBaseUrl) {
    mcp["chrome-devtools"] = {
      type: "local",
      command: [
        "npx",
        "-y",
        "chrome-devtools-mcp@latest",
        `--browser-url=${agentCdpBaseUrl}`,
        "--no-usage-statistics",
        "--screenshot-format=jpeg",
        "--screenshot-max-width=1280",
      ],
      enabled: true,
    };
  }

  return {
    ...runtimeConfig,
    default_agent: runtimeConfig.default_agent ?? "sofia",
    agent: {
      sofia: {
        description: "Sofia App default agent",
        mode: "primary",
        temperature: 0.2,
        prompt: SOFIA_AGENT_PROMPT,
        permission: {
          skill: {
            // Sofia App supplies its own current skill routing and no longer
            // supports these engine or legacy workspace skills.
            "customize-opencode": "deny",
            "get-started": "deny",
            "command-creator": "deny",
            "agent-creator": "deny",
            "plugin-creator": "deny",
          },
        },
      },
    },
    plugin: [
      sofiaExtensionsPreviewPluginPath(),
      sofiaCapabilitiesKnowledgePluginPath(),
      sofiaOfficeAttachmentsPluginPath(),
      sofiaAnthropicAdaptiveThinkingPluginPath(),
      sofiaAnthropicToolSchemaPluginPath(),
      ...runtimePluginList(runtimeConfig),
    ],
    ...(disabledProviders.length ? { disabled_providers: disabledProviders } : {}),
    mcp,
    ...(Object.keys(provider).length ? { provider } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableJsonValue(value[key])]),
  );
}

function stableStringify(value: unknown): string {
  return JSON.stringify(stableJsonValue(value));
}
