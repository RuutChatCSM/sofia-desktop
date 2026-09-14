// Codex session client: the app-side surface for the bundled Sofia (codex)
// engine. Mirrors the opencode SDK's session surface but talks to the
// Sofia App server's /codex/* routes (which drive the engine's JSON-RPC over
// stdio). Used when the selected engine is codex.
import { OpenworkServerError } from "./openwork-server";

export type CodexSessionStatus = "idle" | "running" | "error";

export type CodexSession = {
  id: string; // codex-<threadId>
  threadId: string;
  title: string;
  workspaceId: string;
  created: string;
  turnId: string | null;
  status: CodexSessionStatus;
  model?: string;
  providerId?: string;
  archived?: boolean;
  cwd?: string;
};

export type CodexEvent =
  | { type: "session.created"; session: CodexSession }
  | { type: "session.updated"; session: CodexSession }
  | { type: "message.delta"; sessionId: string; threadId: string; text: string; itemId?: string }
  | { type: "thinking.delta"; sessionId: string; threadId: string; text: string; itemId?: string }
  | { type: "item.started"; sessionId: string; threadId: string; itemType: string; item: unknown; turnId: string }
  | { type: "item.completed"; sessionId: string; threadId: string; itemType: string; item: unknown; turnId: string }
  | { type: "tool.output"; sessionId: string; threadId: string; itemId: string; text: string }
  | { type: "file.patch"; sessionId: string; threadId: string; itemId: string; patch: unknown }
  | { type: "turn.completed"; sessionId: string; threadId: string }
  | { type: "approval.requested"; sessionId: string; threadId: string; params: unknown }
  | { type: "thread.status"; sessionId: string; threadId: string; status: unknown }
  | { type: "error"; sessionId: string; threadId: string; message: string }
  | { type: "stream.ready"; streamId: string };

export type CodexEngineStatus = {
  ok: boolean;
  engine: { bin: string | null } | null;
  sessions: CodexSession[];
};

export type CodexProviderModelWire = {
  id: string;
  name: string;
  reasoning: boolean;
};

export type CodexProviderConfigWire = {
  providerId: string;
  providerName: string;
  baseUrl: string | null;
  envKey: string | null;
  wireApi: "responses" | "chatcompletions";
  models: CodexProviderModelWire[];
};

export type CodexEngineConfigWire = {
  defaultProviderId: string | null;
  model: string | null;
  providers: CodexProviderConfigWire[];
};

export type CodexSessionClientOptions = {
  baseUrl: string;
  token: string;
  hostToken?: string;
  workspaceId: string;
};

/** A pending codex engine approval surfaced by the host ApprovalService. */
export type CodexApprovalRequest = {
  id: string;
  workspaceId: string;
  action: string;
  summary: string;
  paths: string[];
  createdAt: number;
  actor: { name: string; type: string } | null;
};

const DEFAULT_TIMEOUT_MS = 15_000;

function buildHeaders(options: { token?: string; hostToken?: string }): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.token?.trim()) headers.authorization = `Bearer ${options.token.trim()}`;
  if (options.hostToken?.trim()) headers["x-sofia-host-token"] = options.hostToken.trim();
  return headers;
}

async function requestJson<T>(
  baseUrl: string,
  path: string,
  options: { method?: string; token?: string; hostToken?: string; body?: unknown; timeoutMs?: number } = {},
): Promise<T> {
  const url = `${baseUrl}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, {
      method: options.method ?? "GET",
      headers: buildHeaders(options),
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text();
  const json = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const code = typeof json?.code === "string" ? json.code : "request_failed";
    const message = typeof json?.message === "string" ? json.message : response.statusText;
    throw new OpenworkServerError(response.status, code, message, json?.details);
  }
  return json as T;
}

export function createCodexSessionClient(options: CodexSessionClientOptions) {
  const workspacePath = `/workspace/${encodeURIComponent(options.workspaceId)}`;

  return {
    baseUrl: options.baseUrl,
    engine: () =>
      requestJson<CodexEngineStatus>(options.baseUrl, `${workspacePath}/codex/engine`, {
        token: options.token,
        hostToken: options.hostToken,
      }),

    config: () =>
      requestJson<{ ok: boolean; config: CodexEngineConfigWire }>(
        options.baseUrl,
        `${workspacePath}/codex/config`,
        { token: options.token, hostToken: options.hostToken },
      ),

    listSessions: async () => (await requestJson<CodexEngineStatus>(
      options.baseUrl,
      `${workspacePath}/codex/engine`,
      { token: options.token, hostToken: options.hostToken },
    )).sessions,

    createSession: (input: { title?: string; prompt?: string; cwd?: string; model?: string; providerId?: string }) =>
      requestJson<{ ok: boolean; session: CodexSession }>(
        options.baseUrl,
        `${workspacePath}/codex/sessions`,
        {
          token: options.token,
          hostToken: options.hostToken,
          method: "POST",
          body: {
            title: input.title,
            prompt: input.prompt,
            cwd: input.cwd,
            model: input.model,
            providerId: input.providerId,
          },
          timeoutMs: 60_000,
        },
      ),

    prompt: (sessionId: string, text: string, selection?: { model?: string; providerId?: string }) =>
      requestJson<{ ok: boolean; session: CodexSession }>(
        options.baseUrl,
        `${workspacePath}/codex/sessions/${encodeURIComponent(sessionId)}/prompt`,
        {
          token: options.token,
          hostToken: options.hostToken,
          method: "POST",
          body: { text, model: selection?.model, providerId: selection?.providerId },
          timeoutMs: 60_000,
        },
      ),

    abort: (sessionId: string) =>
      requestJson<{ ok: boolean }>(
        options.baseUrl,
        `${workspacePath}/codex/sessions/${encodeURIComponent(sessionId)}/abort`,
        { token: options.token, hostToken: options.hostToken, method: "POST", timeoutMs: 30_000 },
      ),

    renameSession: (sessionId: string, title: string) =>
      requestJson<{ ok: boolean; session: CodexSession }>(
        options.baseUrl,
        `${workspacePath}/codex/sessions/${encodeURIComponent(sessionId)}/rename`,
        { token: options.token, hostToken: options.hostToken, method: "POST", body: { title } },
      ),

    deleteSession: (sessionId: string) =>
      requestJson<{ ok: boolean }>(
        options.baseUrl,
        `${workspacePath}/codex/sessions/${encodeURIComponent(sessionId)}`,
        { token: options.token, hostToken: options.hostToken, method: "DELETE", timeoutMs: 30_000 },
      ),

    /** Pending codex engine approvals (host-scoped ApprovalService). */
    getApprovals: () =>
      requestJson<{ items: CodexApprovalRequest[] }>(
        options.baseUrl,
        "/approvals",
        { token: options.token, hostToken: options.hostToken, timeoutMs: 30_000 },
      ),

    /** Approve/deny a pending codex approval. */
    respondApproval: (id: string, allow: boolean) =>
      requestJson<{ ok: boolean; allowed: boolean }>(
        options.baseUrl,
        `/approvals/${encodeURIComponent(id)}`,
        {
          token: options.token,
          hostToken: options.hostToken,
          method: "POST",
          body: { reply: allow ? "allow" : "deny" },
          timeoutMs: 30_000,
        },
      ),

    getApprovalMode: () =>
      requestJson<{ mode: string }>(
        options.baseUrl,
        "/approvals/mode",
        { token: options.token, hostToken: options.hostToken, timeoutMs: 30_000 },
      ),

    setApprovalMode: (mode: string) =>
      requestJson<{ ok: boolean; mode: string }>(
        options.baseUrl,
        "/approvals/mode",
        {
          token: options.token,
          hostToken: options.hostToken,
          method: "PUT",
          body: { mode },
          timeoutMs: 30_000,
        },
      ),

    archiveSession: (sessionId: string, archived: boolean) =>
      requestJson<{ ok: boolean; session: CodexSession }>(
        options.baseUrl,
        `${workspacePath}/codex/sessions/${encodeURIComponent(sessionId)}/archive`,
        {
          token: options.token,
          hostToken: options.hostToken,
          method: "POST",
          body: { archived },
          timeoutMs: 30_000,
        },
      ),

    items: (sessionId: string) =>
      requestJson<{ ok: boolean; items: Array<{ turnId: string; item: Record<string, unknown> }> }>(
        options.baseUrl,
        `${workspacePath}/codex/sessions/${encodeURIComponent(sessionId)}/items`,
        { token: options.token, hostToken: options.hostToken, timeoutMs: 30_000 },
      ),

    /** Open the SSE event stream; invokes `onEvent` per parsed frame. */
    stream: async (signal: AbortSignal, onEvent: (event: CodexEvent) => void): Promise<void> => {
      const url = `${options.baseUrl}${workspacePath}/codex/stream`;
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal.addEventListener("abort", abort, { once: true });
      try {
        const response = await fetch(url, {
          headers: buildHeaders({ token: options.token, hostToken: options.hostToken }),
          signal: controller.signal,
        });
        if (!response.ok || !response.body) {
          const text = await response.text().catch(() => "");
          throw new OpenworkServerError(response.status, "stream_failed", text || response.statusText);
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const dataLine = frame.split("\n").find((line) => line.startsWith("data:"));
            if (!dataLine) continue;
            const raw = dataLine.slice(5).trim();
            if (!raw) continue;
            try {
              onEvent(JSON.parse(raw) as CodexEvent);
            } catch {
              // skip malformed frames
            }
          }
        }
      } finally {
        signal.removeEventListener("abort", abort);
      }
    },
  };
}

export type CodexSessionClient = ReturnType<typeof createCodexSessionClient>;
