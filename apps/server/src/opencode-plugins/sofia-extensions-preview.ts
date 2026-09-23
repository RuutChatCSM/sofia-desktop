import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import { z } from "zod";
import type { SofiaAffordanceEffects } from "@sofia/types/sofia-affordance";
import { automationProposalSchema } from "@sofia/types/automations";
import {
  combineInstructionSections,
  composeAgentInstructions,
  createInstructionSection,
} from "./agent-instruction-compose.js";
import {
  composeSkillAuthoringInstruction,
  resolveSofiaAutomationInstruction,
  resolveSofiaConnectSkillInstruction,
  resolveSofiaExtensionDiscoveryInstruction,
  type OpenCodeContext,
  type SofiaEngineMcpStatusClient,
} from "./sofia-extensions-preview-steering.js";
import {
  buildSofiaProviderContributions,
  type ConnectSkillDescriptor,
  type EngineMcpDescriptor,
} from "./sofia-provider-adapters.js";

type ExtensionActionPayload = {
  extensionId: string;
  action: string;
  args: Record<string, unknown>;
  context: ReturnType<typeof contextPayload>;
};

const listActionsArgsSchema = z.object({
  extensionId: z.string().optional().describe("Optional extension id to filter by, such as google-workspace."),
});

const callArgsSchema = z.object({
  extensionId: z.string().describe("Extension id, such as google-workspace."),
  action: z.string().describe("Action id from extension.actions."),
  args: z.record(z.string(), z.unknown()).optional().describe("JSON arguments for the action."),
});

const sofiaAffordanceRequestSchema = z.object({
  id: z.string().trim().min(1).describe("Semantic affordance id from sofia_context."),
  args: z.record(z.string(), z.unknown()).optional().describe("JSON arguments for the affordance."),
  expectedRevision: z.number().int().nonnegative().optional().describe("Context revision from sofia_context. Use for commands to prevent stale writes."),
  actor: z.string().trim().min(1).optional().describe("Optional agent or client id used to attribute serialized commands."),
});

const connectSkillDescriptorSchema = z.object({
  name: z.string(),
  title: z.string().optional(),
  description: z.string(),
  capability: z.string(),
}).passthrough();

const connectSkillsEnvelopeSchema = z.object({
  skills: z.array(connectSkillDescriptorSchema),
}).passthrough();

const sessionSearchArgsSchema = z.object({
  query: z.string().trim().min(1).describe("Text to search for across Sofia App session titles and message transcripts."),
  workspaceId: z.string().trim().optional().describe("Optional Sofia App workspace id/name to limit the search."),
  limit: z.number().int().positive().max(20).optional().describe("Maximum matching sessions to return. Defaults to 10, max 20."),
  scanLimit: z.number().int().positive().max(500).optional().describe("Maximum newest sessions to scan across matching workspaces. Defaults to 100, max 500."),
  messageLimit: z.number().int().positive().max(1000).optional().describe("Maximum recent messages to load per scanned session. Defaults to 400, max 1000."),
});

const sessionReadArgsSchema = z.object({
  sessionId: z.string().trim().min(1).describe("Sofia App/Sofia engine session ID returned by session.search."),
  workspaceId: z.string().trim().optional().describe("Optional Sofia App workspace id/name. Omit to resolve the session across all workspaces."),
  count: z.number().int().positive().max(100).optional().describe("Number of recent transcript messages to return. Defaults to 30, max 100."),
});

const sessionCreateArgsSchema = z.object({
  sessions: z.array(z.object({
    title: z.string().trim().min(1).max(120).describe("Short title shown in the Sofia App session list."),
    prompt: z.string().trim().min(1).max(100_000).describe("Self-contained task to start in the new session."),
  })).min(1).describe("One entry per new session to create and start."),
  workspaceId: z.string().trim().optional().describe("Optional Sofia App workspace id/name. Defaults to the workspace containing the current session."),
});

const workspaceSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  path: z.string().optional(),
  displayName: z.string().optional(),
}).passthrough();

const workspaceListEnvelopeSchema = z.object({
  items: z.array(workspaceSchema),
}).passthrough();

const sessionTimeSchema = z.object({
  created: z.number().optional(),
  updated: z.number().optional(),
}).passthrough();

const sessionInfoSchema = z.object({
  id: z.string(),
  title: z.string().nullish(),
  time: sessionTimeSchema.optional(),
}).passthrough();

const sessionListEnvelopeSchema = z.object({
  items: z.array(sessionInfoSchema),
}).passthrough();

const sessionEnvelopeSchema = z.object({
  item: sessionInfoSchema,
}).passthrough();

const createdSessionEnvelopeSchema = z.object({
  item: sessionInfoSchema,
  started: z.boolean(),
}).passthrough();

const sessionPartSchema = z.object({
  type: z.string().optional(),
  text: z.string().optional(),
  synthetic: z.boolean().optional(),
  ignored: z.boolean().optional(),
}).passthrough();

const sessionMessageSchema = z.object({
  info: z.object({
    id: z.string(),
    role: z.string(),
    time: sessionTimeSchema.optional(),
  }).passthrough(),
  parts: z.array(sessionPartSchema),
}).passthrough();

const sessionMessagesEnvelopeSchema = z.object({
  items: z.array(sessionMessageSchema),
}).passthrough();

const SOFIA_AGENT_SURFACE_INSTRUCTION =
  `## Sofia App context
Use sofia_context when the request depends on the current Sofia App screen, open tabs, split view, focused pane, sidebar, side panel, settings panel, or available app actions.
Each affordance declares its effects and executor. Use sofia_query only for side-effect-free affordances whose executor is Sofia App. Use sofia_execute for Sofia App commands without activating the desktop window. If executor names another tool, call that exact tool instead.
Reading another session does not require opening it. Prefer session.search then session.read for transcript questions; use session.create for new chats and a UI command only when the user asks to navigate.
To open settings or navigate the app, use sofia_execute with ids from sofia_context such as settings.panel.open — never browser_* tools for the Sofia App itself.`;

const SOFIA_BROWSER_INSTRUCTION =
  `Do NOT use the chrome-devtools browser tools to interact with the Sofia App itself. They are for browsing external websites.

## Built-in Browser (external websites)
The browser surface is the chrome-devtools MCP server (persistent connection; reuse it, do not spawn another). For web browsing tasks, ALWAYS start with sofia_execute id browser.open_url — it creates a VISIBLE built-in Sofia App browser tab (which is already signed in to the user's session) and returns its browser_url plus target_id.
CRITICAL: After browser.open_url, call list_pages and select_page the page whose URL matches the URL you just opened. Do NOT use new_page — new_page creates a separate unauthenticated tab that is invisible to the user. Drive the existing tab: take_snapshot for a low-token a11y tree with uid markers, then click / fill / type_text / navigate_page / take_screenshot. After interacting, check list_console_messages and list_network_requests for errors.

## Browser reliability rules (learned from real sessions)
- browser.open_url and new_page return immediately while the page loads in the background. ALWAYS take_snapshot (or wait_for) after opening or navigating before interacting — never act on an assumed DOM.
- Snapshots go stale the instant the page changes. RE-SNAPSHOT immediately before every click/fill; if a click fails with a stale uid, re-snapshot and retry instead of reusing the old snapshot.
- Before interacting, list_pages to confirm you are on the expected page — the selected page can drift between tabs.
- The a11y snapshot can miss overlay/iframe content. If a target element is missing from the snapshot, use evaluate_script to focus/verify it, but prefer clicking real elements with fresh uids.
- Multi-step forms (login, checkout) surface fields after each step: enter email, click Continue, THEN snapshot to discover the password/code field. Never assume all fields exist up front.
- If clicks keep failing, take_screenshot to check for a blocking overlay (e.g. reCAPTCHA, cookie banner, modal). Reload (navigate_page reload) to clear a stuck overlay, then re-fill from a fresh snapshot.
- Typing + Enter is the most reliable path on SPAs — focus the input, type_text, then press_key Enter.
- For sites behind the user's login, prefer browser.open_url (uses the signed-in panel session); do NOT create new_page which lands in an unauthenticated context.
Do not use browser tools on the Sofia App target (avoid targets with title "Sofia App" or URLs containing ":5173/#/").`;

// ── UI control bridge discovery ──

type UiBridge = { baseUrl: string; token: string };
let cachedBridge: UiBridge | null = null;
let cachedBridgeAt = 0;
const BRIDGE_CACHE_MS = 2_000;
const BRIDGE_TIMEOUT_MS = 5_000;

type SofiaWorkspace = z.infer<typeof workspaceSchema>;
type SessionInfo = z.infer<typeof sessionInfoSchema>;
type SessionMessage = z.infer<typeof sessionMessageSchema>;
type SessionSearchSnippet = { before: string; match: string; after: string };
type SessionSearchResult = {
  workspaceId: string;
  workspace: string;
  sessionId: string;
  title: string;
  updatedAt: number;
  kind: "title" | "message";
  snippet: SessionSearchSnippet;
  role?: string;
  messageId?: string;
  messageIndex?: number;
};
type CreatedSofiaSessionResult = {
  ok: true;
  sessionId: string;
  title: string;
  started: boolean;
  route: string;
};
type FailedSofiaSessionResult = {
  ok: false;
  title: string;
  error: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const MAX_PRESERVED_MCP_APP_RESULT_BYTES = 1024 * 1024;

function preserveMcpResult(output: unknown): void {
  if (!isRecord(output) || !Array.isArray(output.content)) return;

  const appResult = {
    content: output.content,
    ...(output.structuredContent !== undefined ? { structuredContent: output.structuredContent } : {}),
    ...(isRecord(output._meta) ? { _meta: output._meta } : {}),
  };
  try {
    if (new TextEncoder().encode(JSON.stringify(appResult)).byteLength > MAX_PRESERVED_MCP_APP_RESULT_BYTES) return;
  } catch {
    return;
  }

  const existing = isRecord(output.metadata) ? output.metadata : {};
  output.metadata = {
    ...existing,
    // This is transport-only result preservation. Whether the completed tool
    // owns an MCP App is determined later from its current tool definition.
    sofiaMcpApp: appResult,
  };
}

const affordanceReadEffects: SofiaAffordanceEffects = { data: "read", ui: "none", external: false };
const affordanceWriteEffects: SofiaAffordanceEffects = { data: "write", ui: "none", external: false };
const affordanceExternalWriteEffects: SofiaAffordanceEffects = { data: "write", ui: "none", external: true };
// A proposal writes nothing anywhere: it is rendered for a person to act on.
const affordanceProposalEffects: SofiaAffordanceEffects = { data: "none", ui: "none", external: false };

function affordanceResult(
  id: string,
  result: unknown,
  effects: SofiaAffordanceEffects,
) {
  if (isRecord(result) && result.ok === false) {
    return {
      ok: false,
      id,
      error: typeof result.error === "string" ? result.error : `${id} failed`,
      code: "failed",
    };
  }
  return { ok: true, id, result, effects };
}

function unavailableAffordance(id: string, error: string) {
  return { ok: false, id, error, code: "unavailable" };
}

function optionalStringProperty(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const property = value[key];
  return typeof property === "string" && property.trim().length > 0 ? property : undefined;
}

type SofiaEngineMcpStatusFunction = SofiaEngineMcpStatusClient["mcp"]["status"];

function isSofiaEngineMcpStatusFunction(value: unknown): value is SofiaEngineMcpStatusFunction {
  return typeof value === "function";
}

function readEngineMcpStatusClient(value: unknown): SofiaEngineMcpStatusClient | undefined {
  const client = isRecord(value) ? value.client : undefined;
  const mcp = isRecord(client) ? client.mcp : undefined;
  const status = isRecord(mcp) ? mcp.status : undefined;
  if (!isSofiaEngineMcpStatusFunction(status)) return undefined;
  return { mcp: { status: (request) => status.call(mcp, request) } };
}

function normalizeOpenCodeContext(value: unknown): OpenCodeContext {
  const nested = isRecord(value) && isRecord(value.context) ? value.context : value;
  const agent = optionalStringProperty(nested, "agent");
  const sessionID = optionalStringProperty(nested, "sessionID");
  const messageID = optionalStringProperty(nested, "messageID");
  const directory = optionalStringProperty(nested, "directory");
  const worktree = optionalStringProperty(nested, "worktree");
  const workspaceId = optionalStringProperty(nested, "workspaceId");
  const workspaceID = optionalStringProperty(nested, "workspaceID");
  return {
    ...(agent ? { agent } : {}),
    ...(sessionID ? { sessionID } : {}),
    ...(messageID ? { messageID } : {}),
    ...(directory ? { directory } : {}),
    ...(worktree ? { worktree } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    ...(workspaceID ? { workspaceID } : {}),
  };
}

function mergeTransformInputWithFactoryContext(input: unknown, factoryContext: OpenCodeContext): unknown {
  if (Object.keys(factoryContext).length === 0) return input;
  const inputRecord = isRecord(input) ? input : {};
  const inputContext = isRecord(inputRecord.context) ? inputRecord.context : {};
  return {
    ...inputRecord,
    context: {
      ...factoryContext,
      ...inputContext,
    },
  };
}

const SESSION_SEARCH_DEFAULT_LIMIT = 10;
const SESSION_SEARCH_DEFAULT_SCAN_LIMIT = 100;
const SESSION_SEARCH_DEFAULT_MESSAGE_LIMIT = 400;
const SESSION_SEARCH_CONCURRENCY = 6;
const SESSION_SNIPPET_BEFORE = 36;
const SESSION_SNIPPET_AFTER = 72;

function userAppDataDir(): string {
  if (platform() === "darwin") return join(homedir(), "Library", "Application Support");
  if (platform() === "win32") return process.env.APPDATA || join(homedir(), "AppData", "Roaming");
  return process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
}

function uiControlDiscoveryPaths(): string[] {
  return [
    process.env.SOFIA_UI_CONTROL_DISCOVERY?.trim(),
    join(userAppDataDir(), "com.differentai.sofia", "sofia-ui-control.json"),
    join(userAppDataDir(), "com.differentai.sofia.dev", "sofia-ui-control.json"),
  ].filter((p): p is string => Boolean(p));
}

async function discoverUiBridge(): Promise<UiBridge | null> {
  if (cachedBridge && Date.now() - cachedBridgeAt < BRIDGE_CACHE_MS) return cachedBridge;
  for (const candidate of uiControlDiscoveryPaths()) {
    try {
      const raw = await readFile(candidate, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (typeof parsed.baseUrl === "string" && typeof parsed.token === "string") {
        cachedBridge = { baseUrl: parsed.baseUrl, token: parsed.token };
        cachedBridgeAt = Date.now();
        return cachedBridge;
      }
    } catch {
      // Try next
    }
  }
  return null;
}

async function uiBridgeRequest(path: string, options: { method?: string; body?: unknown } = {}): Promise<unknown> {
  const bridge = await discoverUiBridge();
  if (!bridge) return { ok: false, error: "Sofia App UI bridge not available. The desktop app may not be running." };
  try {
    const response = await fetch(`${bridge.baseUrl}${path}`, {
      method: options.method || "GET",
      signal: AbortSignal.timeout(BRIDGE_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${bridge.token}`,
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    });
    const text = await response.text();
    try { return JSON.parse(text); } catch { return { ok: false, error: text || `HTTP ${response.status}` }; }
  } catch (error) {
    cachedBridge = null;
    cachedBridgeAt = 0;
    return { ok: false, error: `UI bridge unreachable: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function serverGet(path: string): Promise<unknown> {
  const { url, token } = requireSofiaServer();
  const response = await fetch(`${url}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const payload = await parseResponse(response);
  if (!response.ok) throw new Error(errorMessage(payload, "Sofia App server request failed"));
  return payload;
}

async function readConnectSkillDescriptors(): Promise<ConnectSkillDescriptor[]> {
  try {
    const parsed = connectSkillsEnvelopeSchema.safeParse(
      await serverGet("/experimental/connect/skills"),
    );
    return parsed.success ? parsed.data.skills : [];
  } catch {
    return [];
  }
}

async function readEngineMcpDescriptors(
  client: SofiaEngineMcpStatusClient | undefined,
  directory: string | undefined,
): Promise<EngineMcpDescriptor[]> {
  if (!client) return [];
  try {
    const result = await client.mcp.status(directory ? { query: { directory } } : undefined);
    const payload = isRecord(result) && result.data !== undefined ? result.data : result;
    if (!isRecord(payload)) return [];
    return Object.entries(payload).map(([name, entry]) => {
      const status = typeof entry === "string"
        ? entry
        : optionalStringProperty(entry, "status");
      return status ? { name, status } : { name };
    });
  } catch {
    return [];
  }
}

async function readSofiaAgentContext(
  engineMcpStatusClient: SofiaEngineMcpStatusClient | undefined,
  engineMcpStatusDirectory: string | undefined,
): Promise<Record<string, unknown>> {
  const [uiResult, skills, mcps] = await Promise.all([
    uiBridgeRequest("/context"),
    readConnectSkillDescriptors(),
    readEngineMcpDescriptors(engineMcpStatusClient, engineMcpStatusDirectory),
  ]);
  const contributions = buildSofiaProviderContributions(skills, mcps);
  const providerAffordances = contributions.flatMap((contribution) => contribution.affordances);
  const uiContext = isRecord(uiResult) && isRecord(uiResult.context) ? uiResult.context : null;
  if (!uiContext) {
    return {
      ok: true,
      context: null,
      ui: uiResult,
      availableAffordances: providerAffordances,
      contributions,
    };
  }
  const uiAffordances = Array.isArray(uiContext.availableAffordances)
    ? uiContext.availableAffordances
    : [];
  return {
    ok: true,
    context: {
      ...uiContext,
      availableAffordances: [...uiAffordances, ...providerAffordances],
      contributions,
    },
  };
}

async function querySofiaAffordance(rawArgs: unknown): Promise<unknown> {
  const request = sofiaAffordanceRequestSchema.parse(rawArgs);
  if (request.id === "session.search") {
    return affordanceResult(
      request.id,
      await searchSofiaSessions(request.args ?? {}),
      affordanceReadEffects,
    );
  }
  if (request.id === "session.read") {
    return affordanceResult(
      request.id,
      await readSofiaSession(request.args ?? {}),
      affordanceReadEffects,
    );
  }
  if (request.id === "extension.actions") {
    const args = listActionsArgsSchema.parse(request.args ?? {});
    const query = args.extensionId ? `?extensionId=${encodeURIComponent(args.extensionId)}` : "";
    return affordanceResult(
      request.id,
      await serverGet(`/experimental/extensions/actions${query}`),
      affordanceReadEffects,
    );
  }
  if (request.id.startsWith("connect.")) {
    return unavailableAffordance(
      request.id,
      "This affordance declares a dedicated Connect executor. Call the tool named in sofia_context.",
    );
  }
  const result = await uiBridgeRequest("/query", {
    method: "POST",
    body: request,
  });
  return isRecord(result) && typeof result.ok === "boolean"
    ? result
    : unavailableAffordance(request.id, "Sofia App UI query returned an invalid response.");
}

async function executeSofiaAffordance(
  rawArgs: unknown,
  context: OpenCodeContext,
): Promise<unknown> {
  const request = sofiaAffordanceRequestSchema.parse(rawArgs);
  if (request.id === "session.create") {
    return affordanceResult(
      request.id,
      await createSofiaSessions(request.args ?? {}, context),
      affordanceWriteEffects,
    );
  }
  if (request.id === "automation.propose") {
    return affordanceResult(
      request.id,
      proposeAutomation(request.args ?? {}),
      affordanceProposalEffects,
    );
  }
  if (request.id === "extension.call") {
    const args = callArgsSchema.parse(request.args ?? {});
    return affordanceResult(
      request.id,
      await postJson("/experimental/extensions/call", {
        extensionId: args.extensionId,
        action: args.action,
        args: args.args ?? {},
        context: contextPayload(context),
      }),
      affordanceExternalWriteEffects,
    );
  }
  if (request.id.startsWith("connect.")) {
    return unavailableAffordance(
      request.id,
      "This affordance declares a dedicated Connect executor. Call the tool named in sofia_context.",
    );
  }
  const result = await uiBridgeRequest("/command", {
    method: "POST",
    body: request,
  });
  return isRecord(result) && typeof result.ok === "boolean"
    ? result
    : unavailableAffordance(request.id, "Sofia App UI command returned an invalid response.");
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ");
}

function buildSessionSnippet(text: string, index: number, length: number): SessionSearchSnippet {
  const start = Math.max(0, index - SESSION_SNIPPET_BEFORE);
  const end = Math.min(text.length, index + length + SESSION_SNIPPET_AFTER);
  const before = `${start > 0 ? "..." : ""}${collapseWhitespace(text.slice(start, index)).trimStart()}`;
  const after = `${collapseWhitespace(text.slice(index + length, end)).trimEnd()}${end < text.length ? "..." : ""}`;
  return { before, match: text.slice(index, index + length), after };
}

function workspaceLabel(workspace: SofiaWorkspace): string {
  return workspace.displayName?.trim() || workspace.name?.trim() || workspace.path?.trim() || workspace.id;
}

function sessionTitle(session: SessionInfo): string {
  return session.title?.trim() || session.id;
}

function sessionUpdatedAt(session: SessionInfo): number {
  return session.time?.updated ?? session.time?.created ?? 0;
}

function messageText(message: SessionMessage): string {
  const parts: string[] = [];
  for (const part of message.parts) {
    if (part.type !== "text") continue;
    if (part.synthetic || part.ignored) continue;
    const text = part.text?.trim();
    if (text) parts.push(text);
  }
  return parts.join("\n\n");
}

function findTextMatch(text: string, queryLower: string): { index: number; length: number } | null {
  const lower = text.toLowerCase();
  const exact = lower.indexOf(queryLower);
  if (exact >= 0) return { index: exact, length: queryLower.length };

  const terms = queryLower.split(/\s+/).filter((term) => term.length > 1);
  if (terms.length < 2) return null;

  let firstIndex = Number.POSITIVE_INFINITY;
  let firstLength = 0;
  for (const term of terms) {
    const index = lower.indexOf(term);
    if (index < 0) return null;
    if (index < firstIndex) {
      firstIndex = index;
      firstLength = term.length;
    }
  }
  return Number.isFinite(firstIndex) ? { index: firstIndex, length: firstLength } : null;
}

function titleSearchResult(workspace: SofiaWorkspace, session: SessionInfo, queryLower: string): SessionSearchResult | null {
  const title = sessionTitle(session);
  const text = `${title} ${workspaceLabel(workspace)}`;
  const match = findTextMatch(text, queryLower);
  if (!match) return null;
  return {
    workspaceId: workspace.id,
    workspace: workspaceLabel(workspace),
    sessionId: session.id,
    title,
    updatedAt: sessionUpdatedAt(session),
    kind: "title",
    snippet: buildSessionSnippet(text, match.index, match.length),
  };
}

function messageSearchResult(workspace: SofiaWorkspace, session: SessionInfo, messages: SessionMessage[], queryLower: string): SessionSearchResult | null {
  let fallback: SessionSearchResult | null = null;
  for (const [index, message] of messages.entries()) {
    const role = message.info.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = messageText(message);
    if (!text) continue;
    const match = findTextMatch(text, queryLower);
    if (!match) continue;
    const result: SessionSearchResult = {
      workspaceId: workspace.id,
      workspace: workspaceLabel(workspace),
      sessionId: session.id,
      title: sessionTitle(session),
      updatedAt: sessionUpdatedAt(session),
      kind: "message",
      role,
      messageId: message.info.id,
      messageIndex: index,
      snippet: buildSessionSnippet(text, match.index, match.length),
    };
    if (role === "user") return result;
    if (!fallback) fallback = result;
  }
  return fallback;
}

async function listSofiaWorkspaces(): Promise<SofiaWorkspace[]> {
  return workspaceListEnvelopeSchema.parse(await serverGet("/workspaces")).items;
}

function filterWorkspaces(workspaces: SofiaWorkspace[], workspaceId?: string): SofiaWorkspace[] {
  const query = workspaceId?.trim().toLowerCase();
  if (!query) return workspaces;
  return workspaces.filter((workspace) => {
    const labels = [workspace.id, workspace.name, workspace.displayName, workspace.path]
      .filter((label): label is string => typeof label === "string" && label.trim().length > 0)
      .map((label) => label.trim().toLowerCase());
    return labels.includes(query);
  });
}

async function listWorkspaceSessions(workspace: SofiaWorkspace, limit: number): Promise<SessionInfo[]> {
  const query = new URLSearchParams({ roots: "true", limit: String(limit) });
  return sessionListEnvelopeSchema.parse(
    await serverGet(`/workspace/${encodeURIComponent(workspace.id)}/sessions?${query.toString()}`),
  ).items;
}

async function readWorkspaceSession(workspace: SofiaWorkspace, sessionId: string): Promise<SessionInfo> {
  return sessionEnvelopeSchema.parse(
    await serverGet(`/workspace/${encodeURIComponent(workspace.id)}/sessions/${encodeURIComponent(sessionId)}`),
  ).item;
}

async function readSessionMessages(workspace: SofiaWorkspace, sessionId: string, limit: number): Promise<SessionMessage[]> {
  const query = new URLSearchParams({ limit: String(limit) });
  return sessionMessagesEnvelopeSchema.parse(
    await serverGet(`/workspace/${encodeURIComponent(workspace.id)}/sessions/${encodeURIComponent(sessionId)}/messages?${query.toString()}`),
  ).items;
}

async function forEachWithConcurrency<T>(items: T[], concurrency: number, run: (item: T) => Promise<void>): Promise<void> {
  let index = 0;
  const worker = async () => {
    while (index < items.length) {
      const item = items[index];
      index += 1;
      if (item !== undefined) await run(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), Math.max(1, items.length)) }, () => worker()));
}

async function searchSofiaSessions(rawArgs: unknown): Promise<object> {
  const args = sessionSearchArgsSchema.parse(rawArgs);
  const resultLimit = args.limit ?? SESSION_SEARCH_DEFAULT_LIMIT;
  const scanLimit = args.scanLimit ?? SESSION_SEARCH_DEFAULT_SCAN_LIMIT;
  const messageLimit = args.messageLimit ?? SESSION_SEARCH_DEFAULT_MESSAGE_LIMIT;
  const queryLower = args.query.trim().toLowerCase();
  const workspaces = filterWorkspaces(await listSofiaWorkspaces(), args.workspaceId);
  if (!workspaces.length) {
    return { ok: false, error: args.workspaceId ? `No workspace matched ${args.workspaceId}` : "No Sofia App workspaces are available" };
  }

  const sessions: Array<{ workspace: SofiaWorkspace; session: SessionInfo }> = [];
  const workspaceErrors: Array<{ workspaceId: string; workspace: string; error: string }> = [];
  await Promise.all(workspaces.map(async (workspace) => {
    try {
      const items = await listWorkspaceSessions(workspace, scanLimit);
      for (const session of items) sessions.push({ workspace, session });
    } catch (error) {
      workspaceErrors.push({ workspaceId: workspace.id, workspace: workspaceLabel(workspace), error: unknownErrorMessage(error) });
    }
  }));

  const sessionsToScan = sessions
    .sort((left, right) => sessionUpdatedAt(right.session) - sessionUpdatedAt(left.session))
    .slice(0, scanLimit);
  const matches: SessionSearchResult[] = [];

  await forEachWithConcurrency(sessionsToScan, SESSION_SEARCH_CONCURRENCY, async ({ workspace, session }) => {
    const titleMatch = titleSearchResult(workspace, session, queryLower);
    try {
      const messages = await readSessionMessages(workspace, session.id, messageLimit);
      const messageMatch = messageSearchResult(workspace, session, messages, queryLower);
      if (messageMatch) matches.push(messageMatch);
      else if (titleMatch) matches.push(titleMatch);
    } catch {
      if (titleMatch) matches.push(titleMatch);
    }
  });

  const results = matches
    .filter((match) => match !== undefined)
    .sort((left, right) => right.updatedAt - left.updatedAt);

  return {
    ok: true,
    query: args.query,
    workspaceCount: workspaces.length,
    totalCandidateSessions: sessions.length,
    scannedSessions: sessionsToScan.length,
    scanLimit,
    messageLimit,
    resultLimit,
    workspaceErrors,
    truncated: sessions.length > sessionsToScan.length || results.length > resultLimit,
    results: results.slice(0, resultLimit),
  };
}

async function readSofiaSession(rawArgs: unknown): Promise<object> {
  const args = sessionReadArgsSchema.parse(rawArgs);
  const count = args.count ?? 30;
  const workspaces = filterWorkspaces(await listSofiaWorkspaces(), args.workspaceId);
  if (!workspaces.length) {
    return { ok: false, error: args.workspaceId ? `No workspace matched ${args.workspaceId}` : "No Sofia App workspaces are available" };
  }

  for (const workspace of workspaces) {
    try {
      const session = await readWorkspaceSession(workspace, args.sessionId);
      const messages = await readSessionMessages(workspace, args.sessionId, count);
      const readable = messages
        .map((message, index) => ({
          index,
          id: message.info.id,
          role: message.info.role,
          text: messageText(message),
        }))
        .filter((message) => message.text.trim().length > 0);
      return {
        ok: true,
        workspaceId: workspace.id,
        workspace: workspaceLabel(workspace),
        sessionId: session.id,
        title: sessionTitle(session),
        updatedAt: sessionUpdatedAt(session),
        returned: readable.length,
        requested: count,
        messages: readable,
      };
    } catch {
      if (args.workspaceId) break;
    }
  }

  return { ok: false, error: `Session ${args.sessionId} was not found in matching Sofia App workspaces` };
}

function serverUrl(): string {
  return String(process.env.SOFIA_SERVER_URL || "").replace(/\/$/, "");
}

function serverToken(): string {
  return String(process.env.SOFIA_SERVER_TOKEN || "");
}

function requireSofiaServer(): { url: string; token: string } {
  const url = serverUrl();
  const token = serverToken();
  if (!url || !token) {
    throw new Error("Sofia App extension tools are only available when Sofia engine is launched by Sofia App.");
  }
  return { url, token };
}

async function parseResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    return { message: text };
  }
}

function getStringProperty(value: unknown, key: string): string | null {
  if (typeof value !== "object" || value === null) return null;
  const property = Reflect.get(value, key);
  return typeof property === "string" ? property : null;
}

function errorMessage(payload: unknown, fallback: string): string {
  return getStringProperty(payload, "message") ?? getStringProperty(payload, "code") ?? fallback;
}

function unknownErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeDirPath(path: string): string {
  return path.replace(/\/+$/, "");
}

async function resolveContextWorkspace(workspaceId: string | undefined, context: OpenCodeContext): Promise<SofiaWorkspace> {
  const workspaces = await listSofiaWorkspaces();
  if (!workspaces.length) throw new Error("No Sofia App workspaces are available");
  if (workspaceId) {
    const match = filterWorkspaces(workspaces, workspaceId).at(0);
    if (!match) throw new Error(`No workspace matched ${workspaceId}`);
    return match;
  }
  const directory = context.worktree?.trim() || context.directory?.trim();
  if (directory) {
    const dir = normalizeDirPath(directory);
    const match = workspaces
      .filter((workspace) => {
        const path = workspace.path?.trim();
        if (!path) return false;
        const root = normalizeDirPath(path);
        return dir === root || dir.startsWith(`${root}/`);
      })
      .sort((left, right) => (right.path?.length ?? 0) - (left.path?.length ?? 0))
      .at(0);
    if (match) return match;
  }
  const only = workspaces.at(0);
  if (workspaces.length === 1 && only) return only;
  throw new Error(`Multiple Sofia App workspaces match; pass workspaceId. Available: ${workspaces.map((workspace) => workspaceLabel(workspace)).join(", ")}`);
}

async function createSofiaSessions(rawArgs: unknown, context: OpenCodeContext): Promise<object> {
  const args = sessionCreateArgsSchema.parse(rawArgs);
  const workspace = await resolveContextWorkspace(args.workspaceId, context);
  const results = await Promise.all(args.sessions.map(async (session): Promise<CreatedSofiaSessionResult | FailedSofiaSessionResult> => {
    try {
      const payload = createdSessionEnvelopeSchema.parse(await postJson(
        `/workspace/${encodeURIComponent(workspace.id)}/sessions`,
        session,
      ));
      return {
        ok: true,
        sessionId: payload.item.id,
        title: payload.item.title?.trim() || session.title,
        started: payload.started,
        route: `/workspace/${encodeURIComponent(workspace.id)}/session/${encodeURIComponent(payload.item.id)}`,
      };
    } catch (error) {
      return {
        ok: false,
        title: session.title,
        error: unknownErrorMessage(error),
      };
    }
  }));
  const created = results.filter((result): result is CreatedSofiaSessionResult => result.ok);
  const failures = results.filter((result): result is FailedSofiaSessionResult => !result.ok);
  return {
    ok: failures.length === 0,
    workspaceId: workspace.id,
    workspace: workspaceLabel(workspace),
    created,
    failures,
  };
}

/**
 * Validates a proposed Automation and hands it back for the renderer to show.
 *
 * Deliberately does no I/O. Automations are active from the moment they exist,
 * and the Den credential lives in the renderer, so an agent can describe an
 * Automation but only a person can create one.
 */
function proposeAutomation(rawArgs: unknown): object {
  const proposal = automationProposalSchema.parse(rawArgs);
  return {
    ok: true,
    kind: "automation-proposal",
    proposal,
    created: false,
    limitation: "This Desktop proposal creates Desktop placement and runs only while a signed-in desktop runner is connected. Use Web or Cloud Chat to create headless Cloud placement.",
  };
}

async function postJson(path: string, body: ExtensionActionPayload | Record<string, unknown>): Promise<unknown> {
  const { url, token } = requireSofiaServer();
  const response = await fetch(url + path, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const payload = await parseResponse(response);
  if (!response.ok) {
    throw new Error(errorMessage(payload, "Sofia App extension call failed"));
  }
  return payload;
}

function contextPayload(context: OpenCodeContext) {
  return {
    agent: context.agent,
    sessionId: context.sessionID,
    messageId: context.messageID,
    workspaceId: context.workspaceId ?? context.workspaceID,
    directory: context.directory,
    worktree: context.worktree,
  };
}

export const SofiaExtensionsPreview = async (factoryInput?: unknown) => {
  const factoryContext = normalizeOpenCodeContext(factoryInput);
  const engineMcpStatusClient = readEngineMcpStatusClient(factoryInput);
  const engineMcpStatusDirectory = factoryContext.directory ?? factoryContext.worktree;
  return {
  "tool.execute.after": async (_input: unknown, output: unknown) => {
    // Sofia engine 1.17.x keeps the text projection of an MCP result but drops
    // structuredContent and result _meta before persisting the completed tool
    // part. Preserve those standard fields in the existing metadata channel
    // so Sofia App can host the UI without replaying the tool call.
    preserveMcpResult(output);
  },
  "experimental.chat.system.transform": async (input: unknown, output: { system: string[] }) => {
    const mergedInput = mergeTransformInputWithFactoryContext(input, factoryContext);
    const [extensionInstruction, skillInstruction, automationInstruction] = await Promise.all([
      resolveSofiaExtensionDiscoveryInstruction(mergedInput, fetch, {
        client: engineMcpStatusClient,
        directory: engineMcpStatusDirectory,
      }),
      resolveSofiaConnectSkillInstruction(mergedInput, fetch),
      resolveSofiaAutomationInstruction(mergedInput, fetch),
    ]);
    const skillAuthoring = composeSkillAuthoringInstruction(extensionInstruction);
    if (process.env.SOFIA_DEV_MODE === "1") {
      console.log("[sofia:skill-authoring] system prompt selected", {
        mode: skillAuthoring.mode,
        prompt: skillAuthoring.prompt,
        directory: normalizeOpenCodeContext(mergedInput).directory ?? factoryContext.directory ?? null,
      });
    }
    // One section id per concern — combine drops empties/duplicates so routing,
    // remote skills, session, and browser guidance never overlap by accident.
    const sections = combineInstructionSections(
      createInstructionSection("routing", extensionInstruction),
      createInstructionSection("agent-surface", SOFIA_AGENT_SURFACE_INSTRUCTION),
      createInstructionSection("skill-authoring", skillAuthoring.prompt),
      createInstructionSection("connect-skills", skillInstruction),
      createInstructionSection("automations", automationInstruction),
      createInstructionSection("browser", SOFIA_BROWSER_INSTRUCTION),
    );
    output.system.push(...composeAgentInstructions(sections));
  },
  tool: {
    sofia_context: {
      description: "Read one semantic snapshot of Sofia App: current screen, retained conversation tabs, split view and focused pane, sidebar and side panel state, settings panel, provider contributions, remote skill guidance, and available affordances with explicit effects and executors.",
      args: {},
      async execute() {
        return JSON.stringify(
          await readSofiaAgentContext(engineMcpStatusClient, engineMcpStatusDirectory),
          null,
          2,
        );
      },
    },
    sofia_query: {
      description: "Run a side-effect-free Sofia App affordance whose executor is Sofia App. Use the exact id and arguments from sofia_context. This reads backend or app state without navigation or window focus.",
      args: sofiaAffordanceRequestSchema.shape,
      async execute(rawArgs: unknown) {
        return JSON.stringify(await querySofiaAffordance(rawArgs), null, 2);
      },
    },
    sofia_execute: {
      description: "Execute an Sofia App command whose executor is Sofia App without activating the desktop window. Use the exact id and arguments from sofia_context, and pass expectedRevision for UI commands to prevent stale writes. If the descriptor names another executor tool, call that tool instead.",
      args: sofiaAffordanceRequestSchema.shape,
      async execute(rawArgs: unknown, context: OpenCodeContext) {
        const mergedContext = { ...factoryContext, ...normalizeOpenCodeContext(context) };
        return JSON.stringify(await executeSofiaAffordance(rawArgs, mergedContext), null, 2);
      },
    },
  },
  };
};
