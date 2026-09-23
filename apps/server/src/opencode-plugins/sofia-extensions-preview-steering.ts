import { z } from "zod";

export type OpenCodeContext = {
  agent?: string;
  sessionID?: string;
  messageID?: string;
  directory?: string;
  worktree?: string;
  workspaceId?: string;
  workspaceID?: string;
};

export type SofiaExtensionConnectState = {
  connectEnabled: boolean;
  connectCatalogEnabled: boolean;
  cloudMcpPresent: boolean;
  cloudHealth: SofiaCloudHealthSummary | null;
  workspace?: {
    resolution?: string;
    id?: string | null;
    directory?: string | null;
    reason?: string;
  };
  googleWorkspace: {
    legacyConfigured: boolean;
  };
};

export type SofiaCloudHealthSummary = {
  usable: boolean;
  usableByCurrentModel: boolean | null;
  phase: string;
  connectCatalogEnabled?: boolean;
  workspace: {
    id: string;
    directory: string | null;
  };
  desired: {
    present: boolean;
    revision: string | null;
  };
  delivery?: {
    appliedRevision?: string | null;
  };
  engine?: {
    status?: string;
  };
  firstFailure: {
    code: string;
    stage: string;
    recommendedAction: string;
    message: string;
  } | null;
};

type SofiaFetch = (url: string, init?: RequestInit) => Promise<Response>;

type EngineMcpStatusRequest = {
  query?: {
    directory?: string;
  };
};

export type SofiaEngineMcpStatusClient = {
  mcp: {
    status: (request?: EngineMcpStatusRequest) => Promise<unknown>;
  };
};

export type SofiaEngineMcpStatusSource = {
  client?: SofiaEngineMcpStatusClient;
  directory?: string;
};

type EngineMcpStatusResult =
  | { found: true; status: string | undefined }
  | { found: false };

type ProviderModel = {
  provider: string;
  model: string;
};

const cloudFailureSchema = z.object({
  code: z.string(),
  stage: z.string(),
  recommendedAction: z.string(),
  message: z.string(),
}).passthrough();

const cloudHealthSchema = z.object({
  usable: z.boolean(),
  usableByCurrentModel: z.boolean().nullable(),
  phase: z.string(),
  connectCatalogEnabled: z.boolean().optional(),
  workspace: z.object({
    id: z.string(),
    directory: z.string().nullable(),
  }).passthrough(),
  desired: z.object({
    present: z.boolean(),
    revision: z.string().nullable(),
  }).passthrough(),
  delivery: z.object({
    appliedRevision: z.string().nullable().optional(),
  }).passthrough().optional(),
  engine: z.object({
    status: z.string().optional(),
  }).passthrough().optional(),
  firstFailure: cloudFailureSchema.nullable(),
}).passthrough();

const connectStateResponseSchema = z.object({
  ok: z.literal(true),
  schemaVersion: z.number(),
  connectEnabled: z.boolean(),
  connectCatalogEnabled: z.boolean().optional(),
  cloudMcpPresent: z.boolean(),
  cloudHealth: cloudHealthSchema.nullable().optional(),
  workspace: z.object({
    resolution: z.string().optional(),
    id: z.string().nullable().optional(),
    directory: z.string().nullable().optional(),
    reason: z.string().optional(),
  }).passthrough().optional(),
  googleWorkspace: z.object({
    legacyConfigured: z.boolean(),
  }).passthrough(),
}).passthrough();

// Both catalogs answer with the same envelope: a rendered prompt section.
const connectCatalogResponseSchema = z.object({
  ok: z.literal(true),
  schemaVersion: z.number(),
  instruction: z.string(),
}).passthrough();

export const SOFIA_EXTENSION_DISCOVERY_INSTRUCTION =
  "If the user asks for something you cannot do with obvious built-in tools, check Sofia App extensions before saying the capability is unavailable. Use sofia_query with id extension.actions to inspect available extension actions, then sofia_execute with id extension.call for the matching action.";

export const SOFIA_CLOUD_SKILL_AUTHORING_INSTRUCTION =
  "Skill creation: Cloud. When the user asks to create a skill, retrieve and follow the listed create-skill remote skill by calling sofia-cloud_execute_capability with its exact <capability>. Create the skill in Sofia Cloud as a private plugin, not in the workspace. For later steps, use share-plugin when the user wants a specific person or team to use a skill, and use add-to-marketplace or add-user-to-marketplace only when the user asks. Use a workspace-local skill only when the user explicitly requests one. Do not create both copies.";

export const SOFIA_LOCAL_SKILL_AUTHORING_INSTRUCTION =
  "Skill creation: Local. Create or update a workspace-local skill only when the user requests one. Keep one skill in .sofia/skills/<skill-name>/SKILL.md, validate it, and re-read it after writing. Do not create a Cloud copy.";

export const SOFIA_CLOUD_CONNECTION_INSTRUCTION =
  "The Sofia Cloud connection is verified ready for this exact workspace/model. For org-connected services, use sofia-cloud_search_capabilities with 2-4 keyword variants, then sofia-cloud_execute_capability with an exact returned name — and only mention services that search (or available_skills) actually returns. When a search result has kind mcp_app, execute that exact capability normally so Sofia App can render its originating standard MCP App; do not import it, ask for a standalone HTML URL, or require a generated direct-tool name. When a remote skill is listed under available_skills, call sofia-cloud_execute_capability with its <capability> directly; do not treat the local Sofia engine skill list as the full inventory. Local Sofia App extensions remain available through sofia_query/sofia_execute with extension.actions and extension.call. Settings > Extensions is the member inventory surface for org and local apps. A successful search proves Sofia Cloud itself is authorized, so a downstream connector failure does not mean Sofia Cloud needs to be reconnected. If a result has kind connection_status, execute that exact capability once so Sofia App renders an actionable connection card, then name connectionStatus.connectionName and relay connectionStatus.action exactly: use Your Connections for the member, the organization Connections dashboard for an org admin, or the provider admin console for a provider-side failure. After the requested human fixes that connector, search again in the same task because results are live, not cached, so unchanged retries return the same error.";

export const SOFIA_CONNECT_SIGN_IN_INSTRUCTION =
  `${SOFIA_EXTENSION_DISCOVERY_INSTRUCTION} Sofia Cloud is not signed in or no desired agent access configuration exists for this workspace. Direct the user to sign in to Sofia App and connect the service in Settings → Connect.`;

export const SOFIA_CONNECT_DISABLED_INSTRUCTION =
  `${SOFIA_EXTENSION_DISCOVERY_INSTRUCTION} Sofia Cloud agent access is explicitly disabled for this workspace. Explain that the user can enable agent access in Settings → Connect.`;

const SOFIA_CLOUD_MCP_NAME = "sofia-cloud";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function getRecordProperty(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function readNestedString(value: unknown, keys: string[]): string | undefined {
  let current = value;
  for (const key of keys) current = getRecordProperty(current, key);
  return readString(current);
}

function readContext(input: unknown): OpenCodeContext {
  const context = getRecordProperty(input, "context");
  const session = getRecordProperty(input, "session");
  const directory = readNestedString(input, ["directory"]) ?? readNestedString(context, ["directory"]) ?? readNestedString(session, ["directory"]);
  const worktree = readNestedString(input, ["worktree"]) ?? readNestedString(context, ["worktree"]) ?? readNestedString(session, ["worktree"]);
  const workspaceId = readNestedString(input, ["workspaceId"]) ?? readNestedString(input, ["workspaceID"]) ?? readNestedString(context, ["workspaceId"]) ?? readNestedString(context, ["workspaceID"]);
  return {
    ...(directory ? { directory } : {}),
    ...(worktree ? { worktree } : {}),
    ...(workspaceId ? { workspaceId } : {}),
  };
}

function readProviderModel(input: unknown): ProviderModel | undefined {
  const model = getRecordProperty(input, "model");
  const provider = readNestedString(model, ["providerID"]) ?? readNestedString(model, ["provider"]) ?? readNestedString(input, ["provider"]);
  const modelId = readNestedString(model, ["modelID"]) ?? readNestedString(model, ["id"]) ?? readNestedString(input, ["modelID"]);
  if (provider && modelId) return { provider, model: modelId };
  const combined = modelId?.includes("/") ? modelId : readNestedString(input, ["model"]) ?? readNestedString(model, ["name"]);
  if (combined?.includes("/")) {
    const [providerPart, ...modelParts] = combined.split("/");
    const joinedModel = modelParts.join("/").trim();
    if (providerPart?.trim() && joinedModel) return { provider: providerPart.trim(), model: joinedModel };
  }
  return undefined;
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
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

function getStringProperty(value: unknown, key: string): string | null {
  if (!isRecord(value)) return null;
  const property = value[key];
  return typeof property === "string" ? property : null;
}

function errorMessage(payload: unknown, fallback: string): string {
  return getStringProperty(payload, "message") ?? getStringProperty(payload, "code") ?? fallback;
}

function readEngineDirectory(input: unknown, fallback?: string): string | undefined {
  const context = readContext(input);
  return context.directory ?? context.worktree ?? readString(fallback);
}

function engineStatusPayload(result: unknown): unknown {
  if (!isRecord(result)) return result;
  const data = result.data;
  if (data !== undefined) return data;
  if (result.error !== undefined) throw new Error("Sofia engine MCP status request failed");
  const responseOk = getRecordProperty(result.response, "ok");
  if (responseOk === false) throw new Error("Sofia engine MCP status request failed");
  return result;
}

function readEngineMcpStatus(result: unknown): EngineMcpStatusResult {
  const entry = getRecordProperty(engineStatusPayload(result), SOFIA_CLOUD_MCP_NAME);
  if (entry === undefined) return { found: false };
  if (typeof entry === "string") return { found: true, status: readString(entry) };
  return { found: true, status: readNestedString(entry, ["status"]) };
}

async function fetchEngineMcpStatus(input: unknown, engine: SofiaEngineMcpStatusSource): Promise<EngineMcpStatusResult> {
  if (!engine.client) return { found: false };
  const directory = readEngineDirectory(input, engine.directory);
  const request = directory ? { query: { directory } } : undefined;
  return readEngineMcpStatus(await engine.client.mcp.status(request));
}

async function fetchSofiaConnectState(input: unknown, fetcher: SofiaFetch): Promise<SofiaExtensionConnectState> {
  const { url, token } = requireSofiaServer();
  const context = readContext(input);
  const providerModel = readProviderModel(input);
  const query = new URLSearchParams();
  const workspaceId = context.workspaceId ?? context.workspaceID;
  const directory = context.worktree ?? context.directory;
  if (workspaceId) query.set("workspaceId", workspaceId);
  if (directory) query.set("directory", directory);
  if (providerModel) {
    query.set("provider", providerModel.provider);
    query.set("model", providerModel.model);
  }
  const suffix = query.size ? `?${query.toString()}` : "";
  const response = await fetcher(`${url}/experimental/connect/state${suffix}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const payload = await parseResponse(response);
  if (!response.ok) throw new Error(errorMessage(payload, "Sofia App connect state request failed"));
  const parsed = connectStateResponseSchema.parse(payload);
  return {
    connectEnabled: parsed.connectEnabled,
    connectCatalogEnabled: parsed.connectCatalogEnabled ?? parsed.connectEnabled,
    cloudMcpPresent: parsed.cloudMcpPresent,
    cloudHealth: parsed.cloudHealth ?? null,
    ...(parsed.workspace ? { workspace: parsed.workspace } : {}),
    googleWorkspace: {
      legacyConfigured: parsed.googleWorkspace.legacyConfigured,
    },
  };
}

export async function resolveSofiaConnectSkillInstruction(_input?: unknown, fetcher: SofiaFetch = fetch): Promise<string> {
  try {
    const { url, token } = requireSofiaServer();
    // Connect skills are server-scoped; workspace/directory query params are unused.
    const response = await fetcher(`${url}/experimental/connect/skills`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) return "";
    return connectCatalogResponseSchema.parse(await parseResponse(response)).instruction;
  } catch {
    return "";
  }
}

export async function resolveSofiaAutomationInstruction(_input?: unknown, fetcher: SofiaFetch = fetch): Promise<string> {
  try {
    const { url, token } = requireSofiaServer();
    // Automations are account-scoped like Connect skills, not per-workspace.
    const response = await fetcher(`${url}/experimental/connect/automations`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) return "";
    return connectCatalogResponseSchema.parse(await parseResponse(response)).instruction;
  } catch {
    return "";
  }
}

export function composeSofiaExtensionDiscoveryInstruction(state: SofiaExtensionConnectState | null): string {
  if (!state) return SOFIA_EXTENSION_DISCOVERY_INSTRUCTION;
  if (state.workspace?.resolution && state.workspace.resolution !== "resolved") return SOFIA_EXTENSION_DISCOVERY_INSTRUCTION;
  const health = state.cloudHealth;
  if (health?.usable === true && health.usableByCurrentModel !== false) return SOFIA_CLOUD_CONNECTION_INSTRUCTION;
  if (health?.phase === "engine_disabled" || health?.firstFailure?.code === "engine_disabled" || health?.firstFailure?.code === "cloud_mcp_disabled") return SOFIA_CONNECT_DISABLED_INSTRUCTION;
  if (health) {
    if (!health.desired.present || health.firstFailure?.code === "cloud_mcp_missing") return SOFIA_CONNECT_SIGN_IN_INSTRUCTION;
    return SOFIA_EXTENSION_DISCOVERY_INSTRUCTION;
  }
  if (!state.connectCatalogEnabled || state.googleWorkspace.legacyConfigured) return SOFIA_EXTENSION_DISCOVERY_INSTRUCTION;
  return SOFIA_CONNECT_SIGN_IN_INSTRUCTION;
}

export function composeSteeringFromEngineMcpStatus(status: string | undefined): string {
  if (status === "connected") return SOFIA_CLOUD_CONNECTION_INSTRUCTION;
  if (status === "disabled") return SOFIA_CONNECT_DISABLED_INSTRUCTION;
  if (status === "needs_auth" || status === "needs_client_registration") return SOFIA_CONNECT_SIGN_IN_INSTRUCTION;
  return SOFIA_EXTENSION_DISCOVERY_INSTRUCTION;
}

export function composeSkillAuthoringInstruction(extensionInstruction: string): {
  mode: "cloud" | "local";
  prompt: string;
} {
  if (extensionInstruction === SOFIA_CLOUD_CONNECTION_INSTRUCTION) {
    return { mode: "cloud", prompt: SOFIA_CLOUD_SKILL_AUTHORING_INSTRUCTION };
  }
  return { mode: "local", prompt: SOFIA_LOCAL_SKILL_AUTHORING_INSTRUCTION };
}

export function resetSofiaExtensionDiscoveryInstructionCacheForTests(): void {
  // Retained for older tests; steering is deliberately uncached so repair is observed immediately.
}

export async function resolveSofiaExtensionDiscoveryInstruction(
  input?: unknown,
  fetcher: SofiaFetch = fetch,
  engine: SofiaEngineMcpStatusSource = {},
): Promise<string> {
  if (engine.client) {
    try {
      // Invariant: the Sofia engine owns MCP registration and builds the
      // prompt tool list, so tool-availability steering must come from that
      // same in-process MCP state. Server health probes may fail for reasons
      // (for example corporate TLS trust) that do not affect engine tools.
      const engineStatus = await fetchEngineMcpStatus(input, engine);
      if (engineStatus.found) return composeSteeringFromEngineMcpStatus(engineStatus.status);
    } catch {
      return SOFIA_EXTENSION_DISCOVERY_INSTRUCTION;
    }
  }
  try {
    return composeSofiaExtensionDiscoveryInstruction(await fetchSofiaConnectState(input, fetcher));
  } catch {
    return SOFIA_EXTENSION_DISCOVERY_INSTRUCTION;
  }
}
