import { resolveSofiaPrompt } from "./sofia-commands.js";
// Codex session manager: owns a ManagedCodexEngine and exposes a small,
// Sofia-shaped session surface for the codex runtime. This is additive —
// engine routes are untouched. Each workspace gets its own engine process
// (mirroring how engine is managed per workspace) and threads are mapped to
// Sofia App session ids via a `codex-<threadId>` scheme.
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { importNodeSqlite } from "./runtime-db.js";
import { ManagedCodexEngine } from "./managed-codex.js";
import type { CodexFeature } from "./codex-version.js";
import { buildSofiaDeveloperInstructions } from "./codex-prompt-harness.js";
import { codexTurnPermissions, readCodexAccessMode } from "./codex-access.js";

/** Normalized path equality (case-insensitive on mac/win). */
function pathsMatch(left: string, right: string): boolean {
  const a = left.replace(/\/+$/, "").toLowerCase();
  const b = right.replace(/\/+$/, "").toLowerCase();
  return a === b || b.startsWith(`${a}/`);
}

/**
 * Whether a persisted thread belongs to a workspace. Codex groups sessions by
 * project, so a thread created in a subdirectory (or from the repo root while
 * the workspace points at a subdir) belongs to this workspace — the TUI lists
 * it. Only an unrelated cwd is excluded. A missing cwd is treated as a match
 * (older stores omit it).
 */
export function threadBelongsToWorkspace(
  workspaceCwd: string,
  threadCwd: string | null | undefined,
): boolean {
  if (!threadCwd) return true;
  return pathsMatch(workspaceCwd, threadCwd) || pathsMatch(threadCwd, workspaceCwd);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Hard cap on the items one transcript read returns. Threads longer than this
 * keep their most recent items; the engine has no "load older" API yet.
 */
export const MAX_TRANSCRIPT_ITEMS = 2000;
/** Items requested per `thread/items/list` page; the engine caps this near 100. */
const TRANSCRIPT_PAGE_SIZE = 100;
/** Page budget so a pathological thread cannot spin the read forever. */
const TRANSCRIPT_PAGE_BUDGET = 200;

/** Why a steer was rejected, so the caller can fall back (start a turn, queue). */
export type CodexSteerFailureCode = "no_active_turn" | "turn_mismatch" | "not_steerable" | "empty_input";

/**
 * Structured steering failure. Mirrors codex's `turn/steer` rejection reasons
 * (`protocol/src/turn_input.rs`): no active turn, expected-turn mismatch, a
 * non-steerable (review/compact) turn, or empty input.
 */
export class CodexSteerError extends Error {
  readonly code: CodexSteerFailureCode;
  readonly actualTurnId: string | null;

  constructor(code: CodexSteerFailureCode, message: string, actualTurnId: string | null = null) {
    super(message);
    this.name = "CodexSteerError";
    this.code = code;
    this.actualTurnId = actualTurnId;
  }
}

/**
 * The thread is held by a live Sofia process elsewhere. The app-server's
 * writer lock is exclusive per thread and released only when the holder exits
 * (or its thread unloads), so no turn can start here until then. The wording
 * mirrors the TUI's external-writer notice; the thread id rides along in the
 * route's 409 details so callers can point at the task in the way.
 */
export class CodexThreadBusyError extends Error {
  readonly threadId: string;

  constructor(threadId: string, cause?: unknown) {
    super("This task is open elsewhere. Close it there and retry before continuing here.", { cause });
    this.name = "CodexThreadBusyError";
    this.threadId = threadId;
  }
}

/**
 * True when the Sofia app-server reports that a thread has no persisted
 * rollout (e.g. a session created but never run, or already removed). Such
 * threads have nothing to archive/delete, so callers treat it as a no-op
 * instead of surfacing a 502.
 */
export function isMissingRolloutError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no rollout found/i.test(message);
}

/**
 * True when the engine refused a resume because the thread already has an
 * active writer. The writer lock is exclusive per thread across every Sofia
 * process sharing a home (`$SOFIA_HOME/thread-writer-locks/<threadId>.lock`),
 * so this means "someone else has it loaded" — not "the thread is broken".
 */
export function isThreadWriterConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /already has an active writer/i.test(message);
}

/** Extract the shell command from a codex custom_tool_call "input" JS string. */
function parseCustomToolCommand(raw: string): string {
  const trimmed = raw.trim();
  // The input is often a JS expression: `const r = await tools.exec_command({cmd:"...", workdir:"..."})`.
  // Prefer the JSON cmd/command if raw is JSON; else pull the `cmd:"..."` string.
  try {
    const parsed = JSON.parse(trimmed);
    if (isRecord(parsed)) {
      if (typeof parsed.cmd === "string" && parsed.cmd) return parsed.cmd;
      if (typeof parsed.command === "string" && parsed.command) return parsed.command;
    }
  } catch {
    // Not pure JSON — extract cmd:"..." / cmd:'...' from the JS expression.
  }
  const cmdMatch = trimmed.match(/\bcmd\s*:\s*(["'`])([\s\S]*?)\1/);
  if (cmdMatch) return cmdMatch[2];
  const commandMatch = trimmed.match(/\bcommand\s*:\s*(["'`])([\s\S]*?)\1/);
  if (commandMatch) return commandMatch[2];
  return trimmed;
}

/** Find a previously emitted item by its call id (to attach tool output). */
function idFromCallId(
  items: Array<{ turnId: string; item: Record<string, unknown> }>,
  callId: string,
): { item: Record<string, unknown> } | null {
  return items.find((entry) => entry.item.id === callId) ?? null;
}

export type CodexEngineHandle = {
  bin: string;
  cwd: string;
  codexHome?: string;
  env?: Record<string, string>;
  /** Interpreter to run `bin` with (e.g. process.execPath for test scripts). */
  interpreter?: string;
};

export type CodexSession = {
  id: string; // Sofia-facing session id: `codex-<threadId>`
  threadId: string;
  title: string;
  workspaceId: string;
  created: string;
  turnId: string | null;
  status: "idle" | "running" | "error";
  archived?: boolean;
  /** cwd of the last active turn (per-turn cwd tracking, like the app's turnCwds). */
  cwd?: string;
  /** Rollout JSONL path (legacy ChatGPT/Codex store) for transcript fallback. */
  rolloutPath?: string | null;
  model?: string;
  providerId?: string;
};

/** The desktop stamps a brand-new task with this title before the engine has
 * seen a turn. It must never mask the title the engine derives from the first
 * user message, and it must not be written to the engine's thread name where
 * every other client would then show it. */
const PENDING_TASK_TITLE = "New Sofia task";

function isPendingTaskTitle(value: string | null | undefined): boolean {
  return (value?.trim() ?? "") === PENDING_TASK_TITLE;
}

/** The engine exposes its own generated title only as `preview`, so prefer a
 * real user/engine name and fall back to the first user message. */
function threadDisplayTitle(thread: { name?: unknown; preview?: unknown }): string {
  const name = typeof thread.name === "string" ? thread.name.trim() : "";
  if (name && !isPendingTaskTitle(name)) return name;
  return typeof thread.preview === "string" ? thread.preview.trim() : "";
}

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
  | { type: "rateLimit.updated"; sessionId: string; threadId: string; rateLimits: unknown }
  | { type: "warning"; sessionId: string; threadId: string; message: string }
  | { type: "error"; sessionId: string; threadId: string; turnId?: string; message: string };

export function codexSessionId(threadId: string): string {
  return `codex-${threadId}`;
}

export function isCodexSessionId(sessionId: string): boolean {
  return sessionId.startsWith("codex-");
}

export class CodexSessionManager {
  private engine: ManagedCodexEngine | null = null;
  private sessions = new Map<string, CodexSession>();
  private events = new EventEmitter();
  private starting: Promise<void> | null = null;
  private approvalQueue: { sessionId: string; threadId: string; params: unknown; resolve: () => void; reject: (reason?: unknown) => void }[] = [];
  private threadAliases: Record<string, string>;
  private loadedThreads = new Set<string>();

  private activeEngine(): ManagedCodexEngine {
    const engine = this.engine;
    if (!engine) throw new Error("Sofia app-server failed to start");
    return engine;
  }

  private readThreadAliases(): Record<string, string> {
    if (!this.handle.codexHome) return {};
    try {
      const parsed = JSON.parse(readFileSync(join(this.handle.codexHome, "sofia-thread-aliases.json"), "utf8"));
      if (!isRecord(parsed)) return {};
      return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    } catch {
      return {};
    }
  }

  private persistThreadAliases(): void {
    if (!this.handle.codexHome) return;
    try {
      writeFileSync(
        join(this.handle.codexHome, "sofia-thread-aliases.json"),
        `${JSON.stringify(this.threadAliases, null, 2)}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
    } catch {
      // Best-effort; the active process still keeps the alias in memory.
    }
  }

  private findRolloutPath(threadId: string): string | null {
    if (!this.handle.codexHome) return null;
    const root = join(this.handle.codexHome, "sessions");
    try {
      const suffix = `-${threadId}.jsonl`;
      const relative = readdirSync(root, { recursive: true, encoding: "utf8" })
        .find((entry) => entry.endsWith(suffix));
      return relative ? join(root, relative) : null;
    } catch {
      return null;
    }
  }

  private recoveredContext(session: CodexSession): string {
    session.rolloutPath ??= this.findRolloutPath(session.id.slice("codex-".length));
    const messages = this.readRolloutItems(session, 30)
      .flatMap(({ item }) => {
        if (item.type === "userMessage" && Array.isArray(item.content)) {
          const text = item.content
            .map((part) => isRecord(part) && typeof part.text === "string" ? part.text : "")
            .filter(Boolean)
            .join("\n");
          return text ? [`User: ${text}`] : [];
        }
        return item.type === "agentMessage" && typeof item.text === "string" && item.text
          ? [`Assistant: ${item.text}`]
          : [];
      })
      .join("\n\n");
    return messages.slice(-16_000);
  }

  private async replaceMissingThread(session: CodexSession, engine: ManagedCodexEngine, selection?: { model?: string; providerId?: string }): Promise<void> {
    const context = this.recoveredContext(session);
    const developerInstructions = buildSofiaDeveloperInstructions({
      workspaceId: session.workspaceId,
      cwd: session.cwd ?? this.handle.cwd,
    });
    const replacementId = await engine.startThread({
      model: selection?.model ?? session.model,
      modelProvider: selection?.providerId ?? session.providerId,
      cwd: session.cwd ?? this.handle.cwd,
      developerInstructions: context
        ? `${developerInstructions}\n\n<recovered_thread_context>\n${context}\n</recovered_thread_context>`
        : developerInstructions,
    });
    const originalThreadId = session.id.slice("codex-".length);
    session.threadId = replacementId;
    this.loadedThreads.add(replacementId);
    this.threadAliases[originalThreadId] = replacementId;
    this.persistThreadAliases();
  }

  private async loadThread(
    session: CodexSession,
    engine: ManagedCodexEngine,
    selection?: { model?: string; providerId?: string },
  ): Promise<void> {
    if (this.loadedThreads.has(session.threadId)) return;
    const overrides = { model: selection?.model, modelProvider: selection?.providerId };
    try {
      await engine.resumeThread(session.threadId, overrides);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // The thread is already loaded here (another connection resumed it, or a
      // turn left it loaded): resuming again cannot succeed, but turns can.
      if (isThreadWriterConflict(error)) {
        if (await this.isThreadLoaded(engine, session.threadId)) {
          this.loadedThreads.add(session.threadId);
          return;
        }
        throw new CodexThreadBusyError(session.threadId, error);
      }
      if (!isMissingRolloutError(error) && !/thread not found/i.test(message)) throw error;
      // Imported sessions belong to another engine home. Resume their durable
      // rollout explicitly instead of sending a turn to an unloaded thread.
      const path = session.rolloutPath ?? this.findRolloutPath(session.threadId);
      if (path && existsSync(path)) {
        await engine.resumeThread(session.threadId, { ...overrides, path });
      } else {
        await this.replaceMissingThread(session, engine, selection);
      }
    }
    this.loadedThreads.add(session.threadId);
  }

  /** Whether the app-server process currently holds this thread loaded. */
  private async isThreadLoaded(engine: ManagedCodexEngine, threadId: string): Promise<boolean> {
    try {
      return (await engine.listLoadedThreads()).includes(threadId);
    } catch {
      return false;
    }
  }

  /**
   * Drop our subscription once a turn ends so the engine can unload the thread
   * (after its idle delay) and release the exclusive writer lock. Without this
   * every session ever run here stays locked against other Sofia processes for
   * the lifetime of this server.
   */
  private releaseThread(threadId: string): void {
    if (!this.loadedThreads.delete(threadId)) return;
    const engine = this.engine;
    if (!engine) return;
    void engine.unsubscribeThread(threadId).catch(() => undefined);
  }

  private setupEngineListeners(engine: ManagedCodexEngine): void {
    // Inbound server->client approval requests must be answered with a response.
    const onReq = (request: unknown) => {
      const r = request as Record<string, unknown>;
      const method = r.method as string;
      if (method === "item/commandExecution/requestApproval" ||
          method === "item/fileChange/requestApproval" ||
          method === "item/permissions/requestApproval") {
        const params = r.params;
        const threadId = params && typeof params === "object" ? Reflect.get(params, "threadId") : undefined;
        const active = typeof threadId === "string" ? this.sessionFor(threadId) : this.activeSession();
        if (active && r.id !== undefined) {
          this.events.emit("event", {
            type: "approval.requested",
            sessionId: active.id,
            threadId: active.threadId,
            params: r.params,
            requestId: r.id,
            method,
          });
        }
      }
    };
    (engine as unknown as { on: (method: string, listener: (params: unknown) => void) => unknown }).on("request", onReq);
    engine.on("error", (params) => {
      const detail = isRecord(params) ? params : {};
      // A retry notification is progress, not a failed turn. Route terminal
      // errors by their thread instead of whichever workspace task is first.
      if (detail.willRetry === true) return;
      const active = typeof detail.threadId === "string"
        ? this.sessionFor(detail.threadId) : this.activeSession();
      const error = isRecord(detail.error) ? detail.error : detail;
      if (active) {
        this.events.emit("event", {
          type: "error",
          sessionId: active.id,
          threadId: active.threadId,
          turnId: typeof detail.turnId === "string" ? detail.turnId : active.turnId ?? undefined,
          message: typeof params === "string" ? params
            : typeof error.message === "string" ? error.message : "The Sofia turn failed. Please retry.",
        });
      }
    });
  }

  private activeSession(): CodexSession | undefined {
    for (const s of this.sessions.values()) {
      if (s.status === "running") return s;
    }
    return undefined;
  }

  constructor(
    private handle: CodexEngineHandle,
    private workspaceId: string | null = null,
    private enableLegacyImport = false,
  ) {
    this.threadAliases = this.readThreadAliases();
  }

  on(listener: (event: CodexEvent) => void): () => void {
    this.events.on("event", listener);
    return () => this.events.off("event", listener);
  }

  onSession(listener: (session: CodexSession) => void): () => void {
    const off = this.on((event) => {
      if (event.type === "session.created" || event.type === "session.updated") listener(event.session);
    });
    return off;
  }

  isRunning(): boolean {
    return this.engine?.isAlive() ?? false;
  }

  /** True if the connected codex binary supports a feature-gated app-server
   * method (compactionImageBudget, threadRevert, ...). False before start. */
  featureSupported(feature: CodexFeature): boolean {
    return this.engine?.featureSupported(feature) ?? false;
  }

  get engineInfo() {
    return this.engine?.info ?? { running: false, pid: null, cwd: this.handle.cwd, userAgent: null, codexHome: null };
  }

  listSessions(): CodexSession[] {
    return [...this.sessions.values()].sort((a, b) => b.created.localeCompare(a.created));
  }

  getSession(sessionId: string): CodexSession | null {
    return this.sessions.get(sessionId) ?? null;
  }

  /** Fetch a thread's persisted items (for restoring a transcript). */
  async getSessionItems(sessionId: string, options?: { limit?: number }): Promise<Array<{ turnId: string; item: Record<string, unknown> }>> {
    await this.start();
    const session = this.sessions.get(sessionId);
    const engine = this.engine;
    if (!session || !engine) return [];
    const limit = options?.limit && options.limit > 0 ? options.limit : MAX_TRANSCRIPT_ITEMS;
    // Read-only by design: `thread/items/list` serves materialized items
    // straight from the thread store, and the rollout JSONL covers threads the
    // store has not seen. Never resume here — resuming takes the thread's
    // exclusive writer lock and subscribes this connection, which kept every
    // browsed session locked against other Sofia processes until we exited.
    try {
      const items = await this.readThreadStoreItems(engine, session.threadId, limit);
      if (items.length > 0) return items;
    } catch {
      // Fall through to the rollout reader.
    }
    return this.readRolloutItems(session, limit);
  }

  /**
   * Read a whole transcript from the thread store, following `nextCursor`.
   *
   * The engine serves about 100 items per page starting at the oldest item, so
   * asking once returned only the beginning of a long thread and silently
   * dropped the recent history. Walks to the end and keeps the newest `limit`
   * items when a thread is longer than the cap.
   */
  private async readThreadStoreItems(
    engine: ManagedCodexEngine,
    threadId: string,
    limit: number,
  ): Promise<Array<{ turnId: string; item: Record<string, unknown> }>> {
    const items: Array<{ turnId: string; item: Record<string, unknown> }> = [];
    let cursor: string | undefined;
    for (let page = 0; page < TRANSCRIPT_PAGE_BUDGET; page += 1) {
      const result = await engine.listThreadItems(threadId, {
        limit: TRANSCRIPT_PAGE_SIZE,
        ...(cursor ? { cursor } : {}),
      });
      items.push(...result.items);
      if (items.length > limit) items.splice(0, items.length - limit);
      if (!result.nextCursor || result.items.length === 0) break;
      cursor = result.nextCursor;
    }
    return items;
  }

  /** Parse a legacy rollout JSONL into ThreadItem-shaped entries. */
  private readRolloutItems(session: CodexSession, limit = 200): Array<{ turnId: string; item: Record<string, unknown> }> {
    const path = session.rolloutPath ?? this.findRolloutPath(session.threadId);
    if (!path || !existsSync(path)) return [];
    session.rolloutPath = path;
    try {
      const raw = readFileSync(path, "utf8");
      const out: Array<{ turnId: string; item: Record<string, unknown> }> = [];
      let currentTurn = "";
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        let parsed: Record<string, unknown>;
        try { parsed = JSON.parse(line); } catch { continue; }
        const type = parsed.type;
        if (type === "event_msg" || type === "turn_context") {
          const payload = isRecord(parsed.payload) ? parsed.payload : {};
          if (isRecord(payload)) {
            const turnId = typeof payload.turn_id === "string" ? payload.turn_id : currentTurn;
            if (turnId) currentTurn = turnId;
          }
          // Messages are emitted only from response_item (the durable record);
          // event_msg.agent_message duplicates the same assistant reply and
          // would double every message in the transcript.
          continue;
        }
        if (type === "response_item") {
          const payload = isRecord(parsed.payload) ? parsed.payload : {};
          const itemType = typeof payload.type === "string" ? payload.type : "";
          const id = typeof payload.id === "string" ? payload.id : `${currentTurn}:item:${out.length}`;
          if (itemType === "reasoning") {
            const content = Array.isArray(payload.content)
              ? (payload.content as unknown[]).map((c) => isRecord(c) && typeof c.text === "string" ? c.text : "").filter(Boolean)
              : [];
            out.push({ turnId: currentTurn, item: { type: "reasoning", id, content } });
          } else if (itemType === "message" && payload.role === "user") {
            const content = Array.isArray(payload.content)
              ? (payload.content as unknown[]).map((c) => isRecord(c) && typeof c.text === "string" ? c.text : "").filter(Boolean)
              : [];
            const text = content.join("\n");
            if (text) out.push({ turnId: currentTurn, item: { type: "userMessage", id, content: [{ type: "text", text }] } });
          } else if (itemType === "message" && payload.role === "assistant") {
            const content = Array.isArray(payload.content)
              ? (payload.content as unknown[]).map((c) => isRecord(c) && typeof c.text === "string" ? c.text : "").filter(Boolean)
              : [];
            out.push({ turnId: currentTurn, item: { type: "agentMessage", id, text: content.join("\n") } });
          } else if (itemType === "function_call") {
            out.push({
              turnId: currentTurn,
              item: {
                type: "dynamicToolCall",
                id,
                tool: typeof payload.name === "string" ? payload.name : "tool",
                arguments: payload.arguments,
                status: "completed",
              },
            });
          } else if (itemType === "function_call_output") {
            const callId = typeof payload.call_id === "string" ? payload.call_id : "";
            if (callId) {
              out.push({
                turnId: currentTurn,
                item: {
                  type: "dynamicToolCall",
                  id: callId,
                  tool: "function",
                  arguments: {},
                  status: "completed",
                  result: payload.output,
                },
              });
            }
          } else if (itemType === "custom_tool_call") {
            // Codex "exec" custom tool calls are shell commands. Map to a
            // commandExecution so the UI renders an inline "used bash" marker.
            const name = typeof payload.name === "string" ? payload.name : "";
            const rawInput = typeof payload.input === "string" ? payload.input : JSON.stringify(payload.input ?? {});
            const command = parseCustomToolCommand(rawInput);
            const callId = typeof payload.call_id === "string" ? payload.call_id : id;
            if (name === "exec" && command) {
              out.push({
                turnId: currentTurn,
                item: {
                  type: "commandExecution",
                  id: callId,
                  command,
                  status: typeof payload.status === "string" ? payload.status : "completed",
                },
              });
            } else if (name) {
              out.push({
                turnId: currentTurn,
                item: {
                  type: "dynamicToolCall",
                  id: callId,
                  tool: name,
                  arguments: payload.input,
                  status: "completed",
                },
              });
            }
          } else if (itemType === "custom_tool_call_output") {
            const callId = typeof payload.call_id === "string" ? payload.call_id : "";
            const commandItem = idFromCallId(out, callId);
            if (commandItem && commandItem.item.type === "commandExecution") {
              commandItem.item.aggregatedOutput = typeof payload.output === "string" ? payload.output : "";
            }
          }
        }
      }
      // Return only the most recent `limit` items (rollouts can be huge).
      return limit > 0 && out.length > limit ? out.slice(-limit) : out;
    } catch {
      return [];
    }
  }

  async start(): Promise<void> {
    if (this.engine?.isAlive()) return;
    if (this.engine) {
      const deadEngine = this.engine;
      this.engine = null;
      await deadEngine.close().catch(() => undefined);
    }
    if (this.starting) return await this.starting;
    const starting = (async () => {
      this.loadedThreads.clear();
      const engine = new ManagedCodexEngine({
        bin: this.handle.bin,        cwd: this.handle.cwd,
        codexHome: this.handle.codexHome,
        env: this.handle.env,
        interpreter: this.handle.interpreter,
      });
      await engine.initialize();
      this.setupEngineListeners(engine);
      engine.onExit(() => {
        // Mark running sessions as errored so the UI can surface the loss.
        for (const session of this.sessions.values()) {
          if (session.status === "running") {
            session.status = "error";
            this.emit({ type: "session.updated", session: { ...session } });
          }
        }
        // Allow start() to re-create the engine instead of reusing the dead
        // handle. The startup promise is cleared by start() itself.
        if (this.engine === engine) this.engine = null;
      });
      engine.on("item/started", (params) => this.handleItemStarted(params));
      engine.on("item/agentMessage/delta", (params) => this.handleAgentDelta(params));
      engine.on("item/reasoning/textDelta", (params) => this.handleReasoningDelta(params));
      engine.on("item/reasoning/summaryTextDelta", (params) => this.handleReasoningDelta(params));
      engine.on("command/exec/outputDelta", (params) => this.handleToolOutput(params));
      engine.on("item/commandExecution/outputDelta", (params) => this.handleToolOutput(params));
      engine.on("item/fileChange/patchUpdated", (params) => this.handleFilePatch(params));
      engine.on("item/completed", (params) => this.handleItemCompleted(params));
      engine.on("warning", (params) => {
        if (!params || typeof params !== "object") return;
        const threadId = Reflect.get(params, "threadId");
        const message = Reflect.get(params, "message");
        const session = typeof threadId === "string" ? this.sessionFor(threadId) : undefined;
        if (session && typeof message === "string") this.emit({ type: "warning", sessionId: session.id, threadId, message });
      });
      engine.on("turn/started", (params) => this.handleTurnStarted(params));
      engine.on("turn/completed", (params) => this.handleTurnCompleted(params));
      engine.on("thread/status/changed", (params) => this.handleThreadStatus(params));
      engine.on("account/rateLimits/updated", (params) => this.handleRateLimits(params));
      // Notification-style (no request id) approval requests, e.g. when the
      // server streams a pending approval as a notification.
      engine.on("item/permissions/requestApproval", (params) => this.handleApproval(params));
      engine.on("item/commandExecution/requestApproval", (params) => this.handleApproval(params));
      engine.on("item/fileChange/requestApproval", (params) => this.handleApproval(params));
      this.engine = engine;
      await this.loadExistingThreads();
    })();
    this.starting = starting;
    try {
      await starting;
    } finally {
      if (this.starting === starting) this.starting = null;
    }
  }

  /** Restore persisted codex threads into the session map across restarts. */
  private async loadExistingThreads(): Promise<void> {
    if (!this.engine) return;
    try {
      const threads = await this.engine.listThreads({ limit: 100, archived: false });
      for (const raw of threads) {
        const thread = raw as {
          id?: string;
          preview?: string;
          name?: string;
          createdAt?: number;
          created_at?: number | string;
          cwd?: string;
          model?: string;
          model_provider?: string;
          modelProvider?: string;
          rollout_path?: string;
          rolloutPath?: string;
        };
        const threadId = typeof thread.id === "string" ? thread.id : "";
        // Group by project, not exact path: a session created in a subdirectory
        // (or from the repo root while the workspace points at a subdir) belongs
        // to this workspace, and the TUI lists it. Strict equality hid them.
        if (!threadBelongsToWorkspace(this.handle.cwd, thread.cwd)) continue;
        const originalThreadId = Object.entries(this.threadAliases).find(([, replacement]) => replacement === threadId)?.[0];
        const sessionId = codexSessionId(originalThreadId ?? threadId);
        if (!threadId || this.sessions.has(sessionId)) continue;
        const createdAt = thread.createdAt ?? thread.created_at;
        const created = typeof createdAt === "number"
          ? new Date(createdAt * 1000).toISOString()
          : typeof thread.created_at === "string"
            ? thread.created_at
            : new Date().toISOString();
        const session: CodexSession = {
          id: sessionId,
          threadId,
          title: threadDisplayTitle(thread) || "Sofia task",
          cwd: thread.cwd ?? this.handle.cwd,
          workspaceId: this.workspaceId ?? "local",
          created,
          turnId: null,
          status: "idle",
          ...(typeof thread.model === "string" ? { model: thread.model } : {}),
          ...(typeof (thread.modelProvider ?? thread.model_provider) === "string"
            ? { providerId: thread.modelProvider ?? thread.model_provider }
            : {}),
          ...(typeof (thread.rolloutPath ?? thread.rollout_path) === "string"
            ? { rolloutPath: thread.rolloutPath ?? thread.rollout_path }
            : {}),
        };
        this.sessions.set(session.id, session);
      }
    } catch {
      // Best-effort: a fresh engine may not expose thread/list; ignore.
    }
    await this.importLegacyCodexSessions();
  }

  /**
   * Import sessions from the user's legacy `~/.codex/state_5.sqlite` (the store
   * the ChatGPT/Codex desktop app writes). The app-server's thread/list only
   * reads the newer thread_history store, so these would otherwise never appear.
   * Best-effort read-only import; never modifies the source DB.
   */
  private async importLegacyCodexSessions(): Promise<void> {
    // Import the user's real ~/.codex/state_5.sqlite (ChatGPT/Codex desktop
    // store) so those sessions appear in Sofia. Read-only; never modifies the
    // source DB. Enabled by the registry (desktop runtime) — isolated unit
    // tests pass false and stay clean.
    if (!this.enableLegacyImport) return;
    let legacyDb: string | null = null;
    const realHome = process.env.REAL_HOME?.trim() || homedir();
    const candidates = [
      join(realHome, ".codex", "state_5.sqlite"),
      join(homedir(), ".codex", "state_5.sqlite"),
    ];
    for (const candidate of candidates) {
      try {
        if (existsSync(candidate)) { legacyDb = candidate; break; }
      } catch { /* skip */ }
    }
    if (!legacyDb) return;
    try {
      const { DatabaseSync } = await importNodeSqlite();
      const sqlite = new DatabaseSync(legacyDb, { readOnly: true });
      const rows = sqlite.prepare(
        "SELECT id, rollout_path, title, created_at, cwd FROM threads",
      ).all() as Array<Record<string, unknown>>;
      sqlite.close();
      const workspacePath = this.handle.cwd;
      for (const row of rows) {
        const threadId = typeof row.id === "string" ? row.id : "";
        if (!threadId || this.sessions.has(codexSessionId(threadId))) continue;
        // Only import sessions whose project matches this workspace's path
        // (codex groups by project cwd; Sofia App groups by workspace).
        const rowCwd = typeof row.cwd === "string" ? row.cwd : "";
        if (workspacePath && rowCwd && !pathsMatch(workspacePath, rowCwd)) continue;
        const createdRaw = row.created_at;
        const created = typeof createdRaw === "number"
          ? new Date(createdRaw * 1000).toISOString()
          : new Date().toISOString();
        const session: CodexSession = {
          id: codexSessionId(threadId),
          threadId,
          title: typeof row.title === "string" && row.title.trim()
            ? row.title.trim().slice(0, 200)
            : "Sofia task",
          workspaceId: this.workspaceId ?? "local",
          created,
          turnId: null,
          status: "idle",
          rolloutPath: typeof row.rollout_path === "string" ? row.rollout_path : null,
        };
        this.sessions.set(session.id, session);
      }
    } catch {
      // Legacy store may be absent or locked; best-effort.
    }
  }

  async close(): Promise<void> {
    await this.engine?.close();
    this.engine = null;
    this.starting = null;
    this.loadedThreads.clear();
  }

  /** Create a thread (session) and optionally start a turn with a prompt. */
  async createSession(input: {
    title: string;
    prompt?: string;
    workspaceId: string;
    cwd?: string;
    model?: string;
    providerId?: string;
  }): Promise<CodexSession> {
    await this.start();
    this.workspaceId = input.workspaceId;
    if (!this.engine) throw new Error("Sofia engine is not running");
    const threadId = await this.engine.startThread({
      cwd: input.cwd ?? this.handle.cwd,
      ...(input.model ? { model: input.model } : {}),
      ...(input.providerId ? { modelProvider: input.providerId } : {}),
      developerInstructions: buildSofiaDeveloperInstructions({
        workspaceId: input.workspaceId,
        cwd: input.cwd ?? this.handle.cwd,
      }),
    });
    const requestedTitle = input.title.trim();
    const session: CodexSession = {
      id: codexSessionId(threadId),
      threadId,
      title: isPendingTaskTitle(requestedTitle) ? "" : requestedTitle,
      workspaceId: input.workspaceId,
      created: new Date().toISOString(),
      turnId: null,
      status: "idle",
      cwd: input.cwd ?? this.handle.cwd,
      ...(input.model ? { model: input.model } : {}),
      ...(input.providerId ? { providerId: input.providerId } : {}),
    };
    this.loadedThreads.add(threadId);
    // Only a real title is worth writing: a placeholder name would shadow the
    // title the engine derives from the first user message.
    if (requestedTitle && !isPendingTaskTitle(requestedTitle)) {
      await this.engine.renameThread(threadId, requestedTitle);
    }
    this.sessions.set(session.id, session);
    this.emit({ type: "session.created", session });
    if (input.prompt) {
      await this.prompt(session.id, input.prompt);
    }
    return { ...session };
  }

  /** Submit a user message to a thread and start a turn. */
  async prompt(sessionId: string, text: string, opts?: { cwd?: string; model?: string; providerId?: string }): Promise<CodexSession> {
    await this.start();
    const engine = this.activeEngine();
    let session = this.sessions.get(sessionId);
    if (!session && isCodexSessionId(sessionId)) {
      const threadId = sessionId.slice("codex-".length);
      try {
        const raw = await engine.readThread(threadId) as { thread?: { id?: string; name?: string; preview?: string; cwd?: string }; id?: string; preview?: string; cwd?: string };
        const thread = raw.thread ?? raw;
        if (thread.id === threadId && typeof thread.cwd === "string" && resolve(thread.cwd) === resolve(this.handle.cwd)) {
          session = {
            id: sessionId,
            threadId,
            title: threadDisplayTitle(thread) || "Sofia task",
            workspaceId: this.workspaceId ?? "local",
            created: new Date().toISOString(),
            turnId: null,
            status: "idle",
            ...(typeof thread.cwd === "string" ? { cwd: thread.cwd } : {}),
          };
          this.sessions.set(sessionId, session);
        }
      } catch {
        // The thread may genuinely no longer exist; preserve the normal error.
      }
    }
    if (!session) throw new Error(`unknown Sofia session: ${sessionId}`);
    if (session.status === "running") throw new Error("This Sofia task is still running. Stop it or wait before sending another turn.");
    // Reserve the task before any RPC so concurrent prompts cannot start two turns.
    session.status = "running";
    session.cwd = opts?.cwd ?? session.cwd ?? this.handle.cwd;
    this.emit({ type: "session.updated", session: { ...session } });
    let turnId: string | null;
    try {
      await this.loadThread(session, engine, opts);
      if ((opts?.model && opts.model !== session.model) || (opts?.providerId && opts.providerId !== session.providerId)) {
        await engine.updateThreadSettings({
          threadId: session.threadId,
          ...(opts.model ? { model: opts.model } : {}),
          ...(opts.providerId ? { modelProvider: opts.providerId } : {}),
        });
        if (opts.model) session.model = opts.model;
        if (opts.providerId) session.providerId = opts.providerId;
      }
      turnId = await engine.startTurn({
        ...codexTurnPermissions(readCodexAccessMode(this.handle.codexHome)),
        threadId: session.threadId,
        input: [{ text: await resolveSofiaPrompt(session.cwd, text) }],
        cwd: session.cwd,
      });
    } catch (error) {
      // A failed resume/settings/start is retryable by the user; never leave a
      // task stuck running or hide the original provider/configuration error.
      session.status = "error";
      session.turnId = null;
      this.emit({ type: "session.updated", session: { ...session } });
      throw error;
    }
    // A fast turn can complete before its start RPC response arrives.
    if (session.status === "running" && !session.turnId) session.turnId = turnId;
    this.emit({ type: "session.updated", session: { ...session } });
    return { ...session };
  }

  async abort(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`unknown Sofia task: ${sessionId}`);
    if (!session.turnId || session.status !== "running") return;
    await this.activeEngine().interruptTurn(session.threadId, session.turnId);
  }

  /** Steer an in-flight turn with a follow-up message (turn/steer). */
  async steer(sessionId: string, text: string): Promise<CodexSession> {
    await this.start();
    const session = this.sessions.get(sessionId);
    if (!session || !this.engine) throw new Error(`unknown Sofia session: ${sessionId}`);
    if (!text.trim()) throw new CodexSteerError("empty_input", "Cannot steer with an empty message");
    if (!session.turnId || session.status !== "running") {
      throw new CodexSteerError("no_active_turn", "There is no active Sofia turn to steer");
    }
    const expectedTurnId = session.turnId;
    let steeredTurnId: string | null = null;
    try {
      steeredTurnId = await this.engine.steerTurn({
        threadId: session.threadId,
        expectedTurnId,
        input: [{ text }],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/no active turn/i.test(message)) throw new CodexSteerError("no_active_turn", message);
      if (/cannot steer a (?:review|compact)|not steerable|active turn cannot be steered/i.test(message)) {
        throw new CodexSteerError("not_steerable", message);
      }
      const mismatch = /expected active turn id [`'"]?([^`'"\s]+)[`'"]? but found [`'"]?([^`'"\s]+)/i.exec(message);
      if (mismatch) throw new CodexSteerError("turn_mismatch", message, mismatch[2] ?? null);
      throw error;
    }
    // Steering changes input, never lifecycle: adopt the engine's turn id so a
    // later steer or interrupt targets the live turn, but never resurrect a
    // turn that completed (or was replaced) while this RPC was pending.
    if (steeredTurnId && session.status === "running" && session.turnId === expectedTurnId) {
      session.turnId = steeredTurnId;
      this.emit({ type: "session.updated", session: { ...session } });
    }
    return { ...session };
  }

  /** Fork a thread into a new thread (thread/fork). Returns the new session. */
  async forkSession(sessionId: string, prompt: string): Promise<CodexSession> {
    await this.start();
    const session = this.sessions.get(sessionId);
    if (!session || !this.engine) throw new Error(`unknown Sofia session: ${sessionId}`);
    const newThreadId = await this.engine.forkThread({ threadId: session.threadId, input: [{ text: prompt }] });
    if (!newThreadId) throw new Error("thread/fork returned no threadId");
    const created = new Date().toISOString();
    const forked: CodexSession = {
      id: codexSessionId(newThreadId),
      threadId: newThreadId,
      title: `${session.title} (fork)`,
      workspaceId: session.workspaceId,
      created,
      turnId: null,
      status: "idle",
      cwd: session.cwd ?? this.handle.cwd,
    };
    this.sessions.set(forked.id, forked);
    this.emit({ type: "session.created", session: forked });
    return { ...forked };
  }

  /** Archive or unarchive a session (thread/archive, thread/unarchive). */
  async setArchived(sessionId: string, archived: boolean): Promise<CodexSession> {
    await this.start();
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`unknown Sofia session: ${sessionId}`);
    // A thread with no persisted rollout has nothing to archive; treat the
    // engine's "no rollout found" as already-archived rather than failing.
    await this.activeEngine()
      .archiveThread(session.threadId, archived)
      .catch((error: unknown) => {
        if (!isMissingRolloutError(error)) throw error;
      });
    session.archived = archived;
    this.emit({ type: "session.updated", session: { ...session } });
    return { ...session };
  }

  async rename(sessionId: string, title: string): Promise<CodexSession> {
    await this.start();
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`unknown Sofia task: ${sessionId}`);
    const name = title.trim();
    if (!name) throw new Error("title is required");
    await this.activeEngine().renameThread(session.threadId, name);
    session.title = name;
    this.emit({ type: "session.updated", session: { ...session } });
    return { ...session };
  }

  /** Unsubscribe from a thread (thread/unsubscribe). */
  async unsubscribeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || !this.engine) return;
    await this.engine.unsubscribeThread(session.threadId).catch(() => undefined);
  }

  async delete(sessionId: string): Promise<void> {
    await this.start();
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.status === "running" && session.turnId) {
      await this.activeEngine().interruptTurn(session.threadId, session.turnId);
    }
    // Delete the persisted thread in the codex engine, not just the in-memory
    // session, so it doesn't re-import on the next loadExistingThreads. A
    // thread with no rollout is already gone — treat it as deleted.
    await this.activeEngine().deleteThread(session.threadId).catch((error: unknown) => {
      if (!isMissingRolloutError(error)) throw error;
    });
    this.sessions.delete(sessionId);
  }

  private emit(event: CodexEvent): void {
    this.events.emit("event", event);
  }

  private sessionFor(threadId: string): CodexSession | null {
    return this.sessions.get(codexSessionId(threadId))
      ?? [...this.sessions.values()].find((session) => session.threadId === threadId)
      ?? null;
  }

  private handleItemStarted(params: unknown): void {
    const { threadId, item, turnId } = params as { threadId?: string; item?: Record<string, unknown>; turnId?: string };
    const session = this.sessionFor(threadId ?? "");
    if (!session) return;
    const itemType = typeof item?.type === "string" ? item.type : "unknown";
    this.emit({ type: "item.started", sessionId: session.id, threadId: threadId ?? "", itemType, item: item ?? null, turnId: typeof turnId === "string" ? turnId : "" });
  }

  private handleAgentDelta(params: unknown): void {
    const { threadId, delta, itemId } = params as { threadId?: string; delta?: string; itemId?: string };
    const session = this.sessionFor(threadId ?? "");
    if (!session || typeof delta !== "string") return;
    this.emit({ type: "message.delta", sessionId: session.id, threadId: threadId ?? "", text: delta, itemId });
  }

  private handleReasoningDelta(params: unknown): void {
    const { threadId, delta, itemId } = params as { threadId?: string; delta?: string; itemId?: string };
    const session = this.sessionFor(threadId ?? "");
    if (!session || typeof delta !== "string") return;
    this.emit({ type: "thinking.delta", sessionId: session.id, threadId: threadId ?? "", text: delta, itemId });
  }

  private handleToolOutput(params: unknown): void {
    const { threadId, itemId, delta } = params as { threadId?: string; itemId?: string; delta?: string };
    const session = this.sessionFor(threadId ?? "");
    if (!session || typeof delta !== "string") return;
    this.emit({
      type: "tool.output",
      sessionId: session.id,
      threadId: threadId ?? "",
      itemId: typeof itemId === "string" ? itemId : "",
      text: delta,
    });
  }

  private handleFilePatch(params: unknown): void {
    const { threadId, itemId, patch } = params as { threadId?: string; itemId?: string; patch?: unknown };
    const session = this.sessionFor(threadId ?? "");
    if (!session) return;
    this.emit({
      type: "file.patch",
      sessionId: session.id,
      threadId: threadId ?? "",
      itemId: typeof itemId === "string" ? itemId : "",
      patch: patch ?? null,
    });
  }

  private handleThreadStatus(params: unknown): void {
    const { threadId, status } = params as { threadId?: string; status?: unknown };
    const session = this.sessionFor(threadId ?? "");
    if (!session) return;
    this.emit({ type: "thread.status", sessionId: session.id, threadId: threadId ?? "", status: status ?? null });
  }

  private handleItemCompleted(params: unknown): void {
    const { threadId, item, turnId } = params as { threadId?: string; item?: Record<string, unknown>; turnId?: string };
    const session = this.sessionFor(threadId ?? "");
    if (!session) return;
    const itemType = typeof item?.type === "string" ? item.type : "unknown";
    this.emit({ type: "item.completed", sessionId: session.id, threadId: threadId ?? "", itemType, item: item ?? null, turnId: typeof turnId === "string" ? turnId : "" });
  }

  private handleTurnStarted(params: unknown): void {
    if (!isRecord(params) || !isRecord(params.turn) || typeof params.turn.id !== "string") return;
    const session = this.sessionFor(typeof params.threadId === "string" ? params.threadId : "");
    if (!session) return;
    session.turnId = params.turn.id;
    session.status = "running";
    this.emit({ type: "session.updated", session: { ...session } });
  }

  /**
   * The engine derives the first title from the user's message but only exposes
   * it as `preview`, so a task created with a placeholder would keep it forever.
   * Adopt the generated title once the turn that produced it has finished.
   */
  private async adoptGeneratedTitle(session: CodexSession, threadId: string): Promise<void> {
    const engine = this.engine;
    const current = session.title.trim();
    if (!engine || (current && !isPendingTaskTitle(current))) return;
    try {
      const raw = await engine.readThread(threadId) as { thread?: { name?: unknown; preview?: unknown } };
      const generated = threadDisplayTitle(raw.thread ?? {});
      if (!generated || generated === current || this.sessions.get(session.id) !== session) return;
      session.title = generated;
      this.emit({ type: "session.updated", session: { ...session } });
    } catch {
      // Best-effort: the placeholder stays until the next read instead.
    }
  }

  private handleTurnCompleted(params: unknown): void {
    const { threadId, thread_id, turn, error } = params as {
      threadId?: string;
      thread_id?: string;
      turn?: { id?: string; status?: string; error?: { message?: string; codex_error_info?: unknown } };
      error?: unknown;
    };
    const tid = threadId ?? thread_id ?? "";
    const session = this.sessionFor(tid);
    if (!session) return;
    if (turn?.id && session.turnId && turn.id !== session.turnId) return;
    session.status = turn?.status === "failed" || turn?.error || error ? "error" : "idle";
    session.turnId = null;
    this.emit({ type: "session.updated", session: { ...session } });
    this.emit({ type: "turn.completed", sessionId: session.id, threadId: tid });
    // Idle now: let the engine unload the thread (and drop its writer lock)
    // instead of holding the session exclusively until this server exits.
    this.releaseThread(tid);
    void this.adoptGeneratedTitle(session, tid);
    const turnError = turn?.error as { message?: string } | undefined;
    const raw = (turnError?.message ?? (typeof error === "string" ? error : (error as { message?: string } | undefined)?.message))?.trim();
    if (raw || session.status === "error") {
      this.emit({ type: "error", sessionId: session.id, threadId: tid, turnId: turn?.id, message: raw || "The Sofia turn failed. Please retry." });
    }
  }

  private handleApproval(params: unknown): void {
    const { threadId } = params as { threadId?: string };
    const session = this.sessionFor(threadId ?? "");
    if (!session) return;
    this.emit({ type: "approval.requested", sessionId: session.id, threadId: threadId ?? "", params });
  }

  private handleRateLimits(params: unknown): void {
    const { threadId, rateLimits } = params as { threadId?: string; rateLimits?: unknown };
    const session = this.sessionFor(threadId ?? "");
    if (!session) return;
    this.emit({ type: "rateLimit.updated", sessionId: session.id, threadId: threadId ?? "", rateLimits: rateLimits ?? null });
  }

  /** Answer an inbound approval request from the codex engine. */
  respondApproval(
    requestId: string | number,
    decision: "Accept" | "AcceptForSession" | "Decline" | "Cancel",
    method?: string,
    requestedPermissions?: Record<string, unknown>,
  ): void {
    if (!this.engine) return;
    // Codex's approval decisions are serde camelCase on the wire
    // (CommandExecutionApprovalDecision / FileChangeApprovalDecision):
    // "accept" | "acceptForSession" | "decline" | "cancel". Sending PascalCase
    // fails deserialization, so codex never receives the decision and the turn
    // hangs.
    if (method === "item/permissions/requestApproval") {
      const allowed = decision === "Accept" || decision === "AcceptForSession";
      this.engine.respond(requestId, {
        permissions: allowed ? requestedPermissions ?? {} : {},
        scope: decision === "AcceptForSession" ? "session" : "turn",
      });
      return;
    }
    const wire = {
      Accept: "accept",
      AcceptForSession: "acceptForSession",
      Decline: "decline",
      Cancel: "cancel",
    }[decision];
    this.engine.respond(requestId, { decision: wire });
  }
}

export function createCodexSessionManager(handle: CodexEngineHandle, workspaceId?: string, enableLegacyImport = false): CodexSessionManager {
  return new CodexSessionManager(handle, workspaceId ?? null, enableLegacyImport);
}
