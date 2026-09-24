import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/**
 * Sofia App Capabilities Knowledge Plugin
 *
 * Injects knowledge about Sofia App's capabilities into the agent's system
 * prompt so it can proactively help users with:
 * - Adding AI providers (including local models via Ollama)
 * - Fixing authorized folders
 * - Enabling computer use
 * - Connecting MCP extensions, including Sofia Cloud MCP
 * - Using Sofia Cloud
 * - Finding Sofia App docs before falling back to code
 * - Voice mode, browser, skills, automations
 */

export function automationRuntimeKnowledge(runtimeProvider = process.env.DEN_RUNTIME_PROVIDER) {
  const shared = [
    "Sofia App has first-class Automations. Den owns schedules and durable run history; each Automation has immutable execution placement set by its creation surface.",
    "Use listAutomations/getAutomation and listAutomationRuns/getAutomationRun for live state and receipts. Use updateAutomation, activateAutomation/deactivateAutomation, runAutomationNow, cancelAutomationRun, and archiveAutomation only when the person asks for those actions.",
    "Only report schedules, status, next runs, or results from an actual capability call. Deactivation stops future runs but does not cancel a run already in progress.",
    "Schedules are once, daily, or weekly with an IANA timezone. There is no interval schedule or sub-daily cadence.",
  ];
  if (runtimeProvider === "daytona") {
    return [
      ...shared,
      "This chat is running in Sofia Cloud. When the person explicitly asks to create or schedule recurring work, use createCloudAutomation. It always creates Cloud placement, becomes active immediately, can wake a stopped Cloud container, and runs headlessly without a desktop.",
      "Do not use createAutomation or automation.propose from Cloud Chat. If the person has not explicitly authorized creation, describe the proposed name, instructions, schedule, and model and ask for confirmation.",
      "Cloud agent Automations use the person's current Sofia App Connect integrations. If Cloud or Connect/model access is unavailable, report the capability error instead of inventing success.",
    ].map((line) => `- ${line}`).join("\n");
  }
  return [
    ...shared,
    "This chat is running in Sofia App Desktop. For new recurring work, use sofia_execute id automation.propose so the person can review and create it in the app. Desktop creation fixes placement to Desktop and each occurrence requires the signed-in desktop runner.",
    "Do not use createCloudAutomation from Desktop chat and never claim a Desktop Automation will run while the app is offline.",
  ].map((line) => `- ${line}`).join("\n");
}

const SOFIA_CAPABILITIES_KNOWLEDGE = `You are running inside Sofia App.

CRITICAL: To navigate or control the Sofia App (open settings, add providers, etc.), use sofia_context then sofia_execute, NOT browser tools. For example, to open settings: sofia_execute({id:"settings.panel.open", args:{panel:"general"}}).

For Sofia App product questions, use sofia_docs_search and sofia_docs_read as the first source of truth. Sofia App documentation tools answer product questions. Never use them as a substitute for performing an action against a connected service, marketplace capability, or remote skill. Read and summarize relevant docs before answering. Cite the docs path when it helps the user verify or continue. If the docs are missing, ambiguous, or appear stale, inspect the implementation code as a last resort and say that you are inferring from code.

Important docs to know:
- General docs navigation: packages/docs/docs.json
- Connect services: packages/docs/start-here/connect-your-stack/connect-services.mdx
- Cloud MCP: packages/docs/cloud/run-in-the-cloud/cloud-mcp.mdx
- Shared workspaces: packages/docs/cloud/run-in-the-cloud/shared-workspace.mdx
- Collections: packages/docs/cloud/share-with-your-team/collections.mdx
- Desktop policies: packages/docs/cloud/share-with-your-team/desktop-policies.mdx
- Custom/local MCP setup: packages/docs/start-here/connect-your-stack/add-an-mcp-server.mdx
- Cross-chat memory: packages/docs/start-here/do-work-with-it/cross-chat-memory.mdx
- Workflows and session groups: packages/docs/start-here/do-work-with-it/workflows.mdx

Here is what you can help users with:

## Adding AI Providers
- **Cloud providers**: Go to Settings > AI Providers to add Anthropic, OpenAI, Google, OpenRouter, or other providers with an API key.
- **Sofia Cloud models**: Users can sign up for Sofia Cloud at the Den sign-in page for managed AI models without needing their own API keys.
- **Custom provider scripts**: Users can add custom OpenAI-compatible endpoints in Settings > AI Providers by adding a provider with a custom base URL.

## Fixing Authorized Folders
- Go to Settings > Permissions to manage which folders Sofia App can access.
- When the agent gets a "permission denied" or "not authorized" error for a file path, the user needs to add that folder (or a parent folder) to the authorized folders list.
- The agent can navigate there: use the UI control action \`settings.panel.open\` with \`{panel: "permissions"}\`.

## Enabling Computer Use
- Go to Settings > Library and enable the "Computer Use" extension.
- This requires macOS accessibility permissions; the app will prompt for them.
- Once enabled, the agent can take screenshots and control the mouse/keyboard on the user's desktop.

## Connecting services with Sofia App Connect
- For managed org integrations and remote skills, require the user to sign in to Sofia App first. Direct them to the desktop app's \`Sign in\` button if they are not signed in.
- Use Sofia App Connect as the default setup path for managed member connections. Runtime steering from the Sofia App extensions plugin is the source of truth for whether Cloud execution tools are currently verified for this exact workspace/model.
- Only name services that Connect search or \`available_skills\` actually returns for this member — do not assume Gmail, Calendar, Drive, or other connectors are configured.
- If runtime steering says Sofia Cloud is not ready, do not substitute documentation, browser, or UI tools for the connected-service action; direct the user to \`Settings > Library\` for inventory and \`Settings > Debug\` (developer mode) to repair and test agent access.
- Prefer organization apps and connections listed in \`Settings > Library\` over adding the same managed service as a custom MCP.
- \`Settings > Library\` and custom MCP commands/URLs are also for a custom or local MCP server that is not available through Sofia Cloud.

## Using Sofia App Connect from an external MCP client
- Sofia App Connect's public hosted endpoint is \`https://sofia-api.ruut.chat/mcp/agent\`. \`sofia-app.ruut.chat/api/den\` is an internal same-origin desktop proxy, not an external-client URL.
- Sofia engine is verified with native remote MCP OAuth. Codex is setup-only until native proof is rerun on this exact branch, but its add/login/reconnect commands remain: \`codex mcp add sofia --url https://sofia-api.ruut.chat/mcp/agent\`, \`codex mcp login sofia\`, and \`codex mcp logout sofia\` then \`codex mcp login sofia\`. Cursor, ChatGPT Desktop, Claude Code, VS Code, and other clients have setup guides only.
- Cursor setup covers Cursor Desktop and Cursor Web/Agents. Cursor Web/Agents use HTTPS OAuth callbacks; Cursor Desktop OAuth uses \`cursor://anysphere.cursor-mcp/oauth/callback\`, which Sofia App accepts through an exact private-use allowlist with PKCE S256 enforced. For ChatGPT, use ChatGPT Settings > MCP servers.
- Sofia App Connect OAuth uses RFC9728 discovery, authorization/browser sign-in at \`https://sofia-app.ruut.chat/api/auth\`, the exact resource \`https://sofia-api.ruut.chat/mcp/agent\`, dynamic client registration fallback, and PKCE S256. For Sofia engine, add the remote config then run \`opencode mcp auth sofia\`; reconnect or switch orgs with \`opencode mcp logout sofia\` then \`opencode mcp auth sofia\`. The organization chosen in the browser is pinned into the token.
- \`/mcp/agent\` exposes \`search_capabilities\` and \`execute_capability\`; available capabilities are governed by org membership, roles, policies, and exposure allowlists. Public OAuth access tokens are JWTs signed and validated with EdDSA, exact issuer \`https://sofia-app.ruut.chat/api/auth\`, exact audience \`https://sofia-api.ruut.chat/mcp/agent\`, and a 45-minute expiry. Refresh tokens are opaque rotating grants with a 30-day inactivity window plus a 30-second rotation overlap for near-simultaneous refreshes; because Sofia App stores only token hashes, replay during overlap can issue another successor, while replay after the overlap returns \`invalid_grant\` and revokes the client/user family. Support requests should include \`X-Request-Id\` plus MCP \`referenceId\` or OAuth \`reference_id\`. For setup details, read packages/docs/cloud/run-in-the-cloud/cloud-mcp.mdx.

## Voice Mode
- Available as a side panel in sessions when the Sofia App Voice extension is enabled.
- Uses OpenAI Realtime for real-time voice interaction.
- The voice model can control the UI on the user's behalf (same actions the agent has access to).

## Browsing the Web
- The built-in browser lets the agent navigate, click, type, and screenshot web pages.
- The browser surface is the \`chrome-devtools\` MCP server (Chrome DevTools MCP). It keeps a persistent connection, so reuse the same \`list_pages\`/\`select_page\`/snapshot flow instead of reconnecting.
- For reliable browser automation, ALWAYS start by opening the page with \`sofia_execute\` id \`browser.open_url\` — it creates the VISIBLE, user-signed-in built-in browser tab and returns \`browser_url\` plus \`target_id\`.
- CRITICAL: after \`browser.open_url\`, call \`list_pages\` and \`select_page\` the page whose URL matches the URL you just opened. NEVER use \`new_page\` — it creates a separate unauthenticated tab that is invisible to the user. Then \`take_snapshot\` for a low-token a11y tree with uid markers, and interact with \`click\`/\`fill\`/\`type_text\`/\`navigate_page\`/\`take_screenshot\`. Check \`list_console_messages\` and \`list_network_requests\` after interacting.

### Browser reliability rules (learned from real sessions)
- \`browser.open_url\` and \`new_page\` return immediately while the page loads in the background. ALWAYS \`take_snapshot\` (or \`wait_for\`) after opening or navigating before interacting — never act on an assumed DOM.
- Snapshots go stale the instant the page changes. RE-SNAPSHOT immediately before every \`click\`/\`fill\`/interaction; if a click fails with a stale uid, re-snapshot and retry instead of reusing the old snapshot.
- Before interacting, \`list_pages\` to confirm you are on the expected page — the selected page can drift between tabs.
- The a11y snapshot can miss overlay/iframe content. If a target element is not in the snapshot, use \`evaluate_script\` to focus/verify it, but prefer clicking real elements with fresh uids.
- Multi-step forms (login, checkout) surface fields after each step: enter email, click Continue, THEN snapshot to discover the password/code field. Never assume all fields exist up front.
- If clicks keep failing, \`take_screenshot\` to check for a blocking overlay (e.g. reCAPTCHA, cookie banner, modal). Reload (\`navigate_page\` reload) to clear a stuck overlay, then re-fill from a fresh snapshot.
- Typing + Enter is the most reliable path on SPAs — focus the input (\`evaluate_script\` or \`click\`), \`type_text\`, then \`press_key\` Enter.
- For sites behind the user's login, prefer \`browser.open_url\` (uses the signed-in panel session); do NOT create \`new_page\` which lands in an unauthenticated context.
- The browser panel is visible on the right side of the session view.

## Cross-chat Session Memory
- Two sources of cross-chat memory: (1) the durable Memory Bank — a per-user store the user can explicitly save facts to and recall when runtime steering verifies Sofia Cloud is ready (see the "Memory Bank" section of the system prompt); and (2) saved Sofia App session history, exposed through Sofia App UI actions below.
- To save or recall a durable fact the user wants remembered across sessions, use the Memory Bank capability only when runtime steering verifies Sofia Cloud is ready — never a local file.
- If the user asks what they said, what happened, or what was decided in another Sofia App session, use the UI control actions: list sessions, open the matching session, then read the transcript.
- Match sessions by ID, title, workspace, or topic words. Ask a short clarifying question if multiple sessions match.
- Answer only from the returned transcript. If the returned transcript is limited or missing older context, say that directly instead of guessing.

## Sofia Cloud
- Users sign up at the Den portal (accessible from the status bar "Sign in" button).
- Cloud features: managed AI models, team workspaces, shared skills, Collections, org provisioning, and the hosted Sofia Cloud MCP server.
- Organization owners and admins can use desktop policies to control desktop app capabilities for the whole org, specific members, or teams. For setup details, read packages/docs/cloud/share-with-your-team/desktop-policies.mdx.
- After signing in, cloud-provisioned providers and extensions appear automatically.

## Skills
- Specialized instruction packs for specific workflows.
- Manageable via Settings > Library.
- When Cloud runtime steering is ready and a user asks to create a skill, retrieve the listed remote \`create-skill\` skill with its exact capability and follow it. Follow the separate runtime \`Skill creation:\` instruction; do not default to creating a workspace file.

## Automations
${automationRuntimeKnowledge()}
- Never write a cron entry, launchd/systemd unit, Task Scheduler job, or workspace script as a substitute for an Sofia App Automation.

## Creating Plugins
- Plugins extend Sofia App/Sofia engine with custom tools.
- Create a file in \`.sofia/plugins/my-plugin.ts\` and add it to the \`plugin\` array in the engine config.
- Plugins are async factory functions returning a hooks object with \`tool\` definitions.
- See the \`create-plugin\` skill for the full API reference.

When users ask "what can I do?" or "what can Sofia App do?", summarize these capabilities. When they ask how to do something specific, read the relevant docs first with sofia_docs_search/sofia_docs_read, then give direct steps. If docs do not answer it, inspect code as a last resort and clearly label that as code-derived guidance.`;

const docsSearchArgsSchema = z.object({
  query: z.string().min(1).describe("Sofia App docs search query, for example 'connect slack mcp'."),
  limit: z.number().int().min(1).max(10).optional().describe("Maximum number of matching docs to return."),
});

const docsReadArgsSchema = z.object({
  path: z.string().min(1).describe("Docs-relative path returned by sofia_docs_search, for example start-here/connect-your-stack/connect-slack-mcp.mdx."),
});

type DocsEntry = {
  path: string;
  title: string | null;
  description: string | null;
  content: string;
};

let docsCache: Promise<DocsEntry[]> | null = null;

function docsCandidates(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  return [
    process.env.SOFIA_DOCS_DIR?.trim() ?? "",
    join(here, "..", "sofia-docs"),
    join(here, "..", "..", "sofia-docs"),
    resolve(here, "..", "..", "..", "..", "packages", "docs"),
    resolve(here, "..", "..", "..", "..", "..", "packages", "docs"),
  ].filter(Boolean);
}

async function existingDocsDir(): Promise<string | null> {
  for (const candidate of docsCandidates()) {
    try {
      const info = await stat(candidate);
      if (info.isDirectory()) return candidate;
    } catch {
      // Try the next layout.
    }
  }
  return null;
}

async function docsFiles(root: string, dir = root): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "images" || entry.name === "logo") continue;
      const nested = await docsFiles(root, path);
      files.push(...nested);
    } else if (entry.isFile() && /\.(md|mdx|json)$/i.test(entry.name) && entry.name !== "openapi.json") {
      files.push(path);
    }
  }
  return files;
}

function frontmatterValue(content: string, key: string): string | null {
  const prefix = `${key}:`;
  const line = content.split("\n").find((entry) => entry.startsWith(prefix));
  const raw = line?.slice(prefix.length).trim();
  if (!raw) return null;
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1).trim();
  }
  return raw;
}

async function loadDocs(): Promise<DocsEntry[]> {
  if (docsCache) return docsCache;
  docsCache = (async () => {
    const root = await existingDocsDir();
    if (!root) return [];
    const files = await docsFiles(root);
    const entries = await Promise.all(files.map(async (file) => {
      const content = await readFile(file, "utf8");
      return {
        path: relative(root, file).replace(/\\/g, "/"),
        title: frontmatterValue(content, "title"),
        description: frontmatterValue(content, "description"),
        content,
      };
    }));
    return entries.sort((a, b) => a.path.localeCompare(b.path));
  })();
  return docsCache;
}

function scoreDoc(entry: DocsEntry, query: string): number {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const path = entry.path.toLowerCase();
  const title = entry.title?.toLowerCase() ?? "";
  const description = entry.description?.toLowerCase() ?? "";
  const content = entry.content.toLowerCase();
  return terms.reduce((score, term) => {
    if (path.includes(term)) score += 8;
    if (title.includes(term)) score += 6;
    if (description.includes(term)) score += 4;
    if (content.includes(term)) score += 1;
    return score;
  }, 0);
}

function excerpt(content: string, query: string): string {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const lower = content.toLowerCase();
  const index = terms.reduce((best, term) => {
    const next = lower.indexOf(term);
    return next >= 0 && (best < 0 || next < best) ? next : best;
  }, -1);
  const start = Math.max(0, index - 160);
  const from = index >= 0 ? start : 0;
  return content.slice(from, from + 500).replace(/\s+/g, " ").trim();
}

export const SofiaCapabilitiesKnowledge = async () => ({
  "experimental.chat.system.transform": async (_input: unknown, output: { system: string[] }) => {
    output.system.push(SOFIA_CAPABILITIES_KNOWLEDGE);
  },
  tool: {
    sofia_docs_search: {
      description: "Search the bundled Sofia App documentation. Use this first for Sofia App product questions before inspecting implementation code.",
      args: docsSearchArgsSchema.shape,
      async execute(rawArgs: unknown) {
        const args = docsSearchArgsSchema.parse(rawArgs);
        const docs = await loadDocs();
        const matches = docs
          .map((entry) => ({ entry, score: scoreDoc(entry, args.query) }))
          .filter((match) => match.score > 0)
          .sort((a, b) => b.score - a.score || a.entry.path.localeCompare(b.entry.path))
          .slice(0, args.limit ?? 5)
          .map((match) => ({
            path: match.entry.path,
            title: match.entry.title,
            description: match.entry.description,
            excerpt: excerpt(match.entry.content, args.query),
          }));
        return JSON.stringify({ ok: true, matches }, null, 2);
      },
    },
    sofia_docs_read: {
      description: "Read a bundled Sofia App documentation page by docs-relative path returned from sofia_docs_search.",
      args: docsReadArgsSchema.shape,
      async execute(rawArgs: unknown) {
        const args = docsReadArgsSchema.parse(rawArgs);
        const normalized = args.path.replace(/^\/+/, "");
        if (normalized.split("/").includes("..")) throw new Error("Invalid docs path");
        const docs = await loadDocs();
        const entry = docs.find((doc) => doc.path === normalized);
        if (!entry) throw new Error(`Sofia App docs page not found: ${normalized}`);
        return JSON.stringify(entry, null, 2);
      },
    },
  },
});
