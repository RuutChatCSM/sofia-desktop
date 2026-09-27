// Sofia session client: the app-side surface for the bundled Sofia (codex)
// engine. Mirrors the engine SDK's session surface but talks to the
// Sofia server's /codex/* routes (which drive the engine's JSON-RPC over
// stdio). Used when the selected engine is codex.
import { SofiaServerError } from "./sofia-server";

import type { WorkspaceChangesResponse } from "@/react-app/domains/session/changes/change-set-source";

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

export type RecordedTurnChanges = {
  sessionId: string;
  turnId: string;
  startedAt: number;
  finalizedAt: number;
  snapshot: WorkspaceChangesResponse;
  unavailable?: string;
};

export type CodexEvent =
  | { type: "session.created"; session: CodexSession }
  | { type: "session.updated"; session: CodexSession }
  | { type: "message.delta"; sessionId: string; threadId: string; text: string; itemId?: string }
  | { type: "thinking.delta"; sessionId: string; threadId: string; text: string; itemId?: string }
  | { type: "item.started"; sessionId: string; threadId: string; itemType: string; item: unknown; turnId: string }
  | { type: "item.completed"; sessionId: string; threadId: string; itemType: string; item: unknown; turnId: string }
  | { type: "backgroundProcesses"; sessionId: string; threadId: string; processes: BackgroundProcess[] }
  | { type: "backgroundProcess.failed"; sessionId: string; threadId: string; workspaceId: string; sessionTitle: string; itemId: string; processId: string; command: string; exitCode?: number }
  | { type: "tool.output"; sessionId: string; threadId: string; itemId: string; text: string }
  | { type: "file.patch"; sessionId: string; threadId: string; itemId: string; patch: unknown }
  | { type: "turn.changes"; sessionId: string; changes: RecordedTurnChanges }
  | { type: "turn.completed"; sessionId: string; threadId: string }
  | { type: "approval.requested"; sessionId: string; threadId: string; params: unknown }
  | { type: "thread.status"; sessionId: string; threadId: string; status: unknown }
  | { type: "warning"; sessionId: string; threadId: string; message: string }
  | { type: "error"; sessionId: string; threadId: string; turnId?: string; message: string }
  | { type: "stream.ready"; streamId: string };

export type BackgroundProcessStatus = "running" | "completed" | "failed" | "declined";

/**
 * A long-running command started through unified exec. The server owns this
 * registry (engine live set + tracked exit status), so the UI just renders it.
 * `processId` is the engine handle passed to terminate — never an OS pid.
 */
export type BackgroundProcess = {
  itemId: string;
  processId: string;
  command: string;
  /** Semantic operation title from the orchestrator; the command is the fallback. */
  title?: string;
  cwd?: string;
  status: BackgroundProcessStatus;
  exitCode?: number;
  aggregatedOutput?: string;
  durationMs?: number;
  osPid?: number;
  cpuPercent?: number;
  rssKb?: number;
};

export type CodexEngineStatus = {
  ok: boolean;
  engine: { bin: string | null } | null;
  sessions: CodexSession[];
};

export type CodexProviderModelWire = {
  id: string;
  name: string;
  reasoning: boolean;
  /** Context window in tokens (models.dev `limit.context`); null when unknown. */
  contextWindow: number | null;
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

/**
 * True when the server refused the request because a live Sofia process
 * elsewhere holds this task's exclusive writer lock. The engine allows a
 * single writer per thread, so the task can be read here but not driven until
 * that process finishes or exits.
 */
export function isThreadWriterConflictError(error: unknown): boolean {
  return error instanceof SofiaServerError && error.code === "thread_writer_conflict";
}

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
    throw new SofiaServerError(response.status, code, message, json?.details);
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

    setProviders: (providers: CodexProviderConfigWire[]) =>
      requestJson<{ ok: boolean; path: string }>(
        options.baseUrl,
        `${workspacePath}/codex/providers`,
        { token: options.token, hostToken: options.hostToken, method: "PUT", body: { providers } },
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

    prompt: (sessionId: string, text: string, selection?: { model?: string; providerId?: string }, images?: string[]) =>
      requestJson<{ ok: boolean; session: CodexSession }>(
        options.baseUrl,
        `${workspacePath}/codex/sessions/${encodeURIComponent(sessionId)}/prompt`,
        {
          token: options.token,
          hostToken: options.hostToken,
          method: "POST",
          body: { text, model: selection?.model, providerId: selection?.providerId, images },
          timeoutMs: 60_000,
        },
      ),

    /** Steer the in-flight turn (codex `turn/steer`). Returns a discriminated
     * result so the caller can fall back to starting a turn or queuing. */
    steer: async (
      sessionId: string,
      text: string,
      images?: string[],
    ): Promise<
      | { outcome: "steered"; session: CodexSession }
      | { outcome: "no_active_turn" }
      | { outcome: "not_steerable" }
      | { outcome: "turn_mismatch"; actualTurnId: string | null }
    > => {
      try {
        const result = await requestJson<{ ok: boolean; session: CodexSession }>(
          options.baseUrl,
          `${workspacePath}/codex/sessions/${encodeURIComponent(sessionId)}/steer`,
          {
            token: options.token,
            hostToken: options.hostToken,
            method: "POST",
            body: { text, images },
            timeoutMs: 60_000,
          },
        );
        return { outcome: "steered", session: result.session };
      } catch (error) {
        if (error instanceof SofiaServerError) {
          if (error.code === "codex_no_active_turn") return { outcome: "no_active_turn" };
          if (error.code === "codex_not_steerable") return { outcome: "not_steerable" };
          if (error.code === "codex_turn_mismatch") {
            const details = error.details as { actualTurnId?: string } | undefined;
            return { outcome: "turn_mismatch", actualTurnId: details?.actualTurnId ?? null };
          }
        }
        throw error;
      }
    },

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

    /** Branch a conversation into a new thread at a message boundary. */
    forkSession: (sessionId: string, messageId?: string) =>
      requestJson<{ ok: boolean; session: CodexSession }>(
        options.baseUrl,
        `${workspacePath}/codex/sessions/${encodeURIComponent(sessionId)}/fork`,
        {
          token: options.token,
          hostToken: options.hostToken,
          method: "POST",
          body: messageId ? { messageId } : {},
          timeoutMs: 30_000,
        },
      ),

    items: (sessionId: string) =>
      requestJson<{ ok: boolean; changes?: RecordedTurnChanges[]; items: Array<{ turnId: string; item: Record<string, unknown> }> }>(
        options.baseUrl,
        `${workspacePath}/codex/sessions/${encodeURIComponent(sessionId)}/items`,
        { token: options.token, hostToken: options.hostToken, timeoutMs: 30_000 },
      ),

    /** Merged background-process view (engine live set + tracked exit state). */
    backgroundProcesses: (sessionId: string) =>
      requestJson<{ ok: boolean; processes: BackgroundProcess[] }>(
        options.baseUrl,
        `${workspacePath}/codex/sessions/${encodeURIComponent(sessionId)}/background-processes`,
        { token: options.token, hostToken: options.hostToken, timeoutMs: 15_000 },
      ),

    /**
     * What the workspace's repository has changed — read from git, not from the
     * model's edit events, so changes made by a shell command, a formatter, a
     * script or an MCP tool are included (see apps/server/src/git-changes.ts).
     */
    workspaceChanges: (
      sessionId: string,
      params?: {
        hunks?: boolean;
        scope?: "unstaged" | "staged";
        /** Read a content snapshot (`{tree, head}`) instead of a file list. */
        snapshot?: boolean;
        baselineTree?: string;
        endTree?: string;
        /** Include the raw unified patch in the delta response. */
        patch?: boolean;
        headBefore?: string | null;
        headAfter?: string | null;
        baselines?: Array<{ repositoryId: string; root: string; tree: string; head: string | null }>;
      },
    ) =>
      requestJson<WorkspaceChangesResponse>(
        options.baseUrl,
        `${workspacePath}/codex/sessions/${encodeURIComponent(sessionId)}/changes?${new URLSearchParams({
          ...(params?.hunks ? { hunks: "1" } : {}),
          ...(params?.scope === "staged" ? { scope: "staged" } : {}),
          ...(params?.snapshot ? { snapshot: "1" } : {}),
          ...(params?.baselineTree ? { baseline: params.baselineTree } : {}),
          ...(params?.endTree ? { end: params.endTree } : {}),
          ...(params?.patch ? { patch: "1" } : {}),
          ...(params?.headBefore ? { headBefore: params.headBefore } : {}),
          ...(params?.headAfter ? { headAfter: params.headAfter } : {}),
          ...(params?.baselines?.length ? { baselines: JSON.stringify(params.baselines) } : {}),
        }).toString()}`,
        { token: options.token, hostToken: options.hostToken, timeoutMs: 20_000 },
      ),

    /** Stop one background process (`processId` is the engine handle). */
    terminateBackgroundProcess: (sessionId: string, processId: string) =>
      requestJson<{ ok: boolean; terminated: boolean }>(
        options.baseUrl,
        `${workspacePath}/codex/sessions/${encodeURIComponent(sessionId)}/background-processes/${encodeURIComponent(processId)}/terminate`,
        { token: options.token, hostToken: options.hostToken, method: "POST", timeoutMs: 30_000 },
      ),

    /** Stop every background process on the session's thread. */
    cleanBackgroundProcesses: (sessionId: string) =>
      requestJson<{ ok: boolean }>(
        options.baseUrl,
        `${workspacePath}/codex/sessions/${encodeURIComponent(sessionId)}/background-processes/clean`,
        { token: options.token, hostToken: options.hostToken, method: "POST", timeoutMs: 30_000 },
      ),

    /** Open the SSE event stream; invokes `onEvent` per parsed frame. */
    stream: (signal: AbortSignal, onEvent: (event: CodexEvent) => void): Promise<void> =>
      consumeSse(
        `${options.baseUrl}${workspacePath}/codex/stream`,
        buildHeaders({ token: options.token, hostToken: options.hostToken }),
        signal,
        (event) => onEvent(event as CodexEvent),
      ),
  };
}

/**
 * Read an SSE response as `data:` frames. Shared by the per-workspace stream and
 * the cross-workspace attention feed.
 */
async function consumeSse(
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
  onEvent: (event: unknown) => void,
): Promise<void> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => "");
      throw new SofiaServerError(response.status, "stream_failed", text || response.statusText);
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
          onEvent(JSON.parse(raw));
        } catch {
          // skip malformed frames
        }
      }
    }
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

export type CodexSessionClient = ReturnType<typeof createCodexSessionClient>;

export type CodexAttentionClientOptions = {
  baseUrl: string;
  token: string;
  hostToken?: string;
};

/**
 * Workspace-independent attention feed. The server owns observation of work, so
 * this stays live regardless of which workspace the renderer is viewing. Events
 * are acknowledged so the server stops replaying them.
 */
export function createCodexAttentionClient(options: CodexAttentionClientOptions) {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  return {
    stream: (signal: AbortSignal, onEvent: (event: CodexEvent) => void): Promise<void> =>
      consumeSse(
        `${baseUrl}/codex/attention`,
        buildHeaders({ token: options.token, hostToken: options.hostToken }),
        signal,
        (event) => onEvent(event as CodexEvent),
      ),
    ack: (ack: { sessionId: string; itemId: string }) =>
      requestJson<{ ok: boolean }>(baseUrl, "/codex/attention/ack", {
        token: options.token,
        hostToken: options.hostToken,
        method: "POST",
        body: ack,
        timeoutMs: 10_000,
      }),
  };
}

export type CodexAttentionClient = ReturnType<typeof createCodexAttentionClient>;
