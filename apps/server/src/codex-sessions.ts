import { historyReadScheduler } from "./history-read-scheduler.js";
import { readRolloutLines, RolloutRecordTooLargeError } from "./rollout-lines.js";
import { isPlaceholderTaskTitle, parseCodexSessionTitles, selectCodexThreadName, threadDisplayTitle, threadTitleFromEngineText } from "./codex-session-titles.js";
import { parseRolloutLines, TRANSCRIPT_RETAINED_CHARS, reconcileRolloutItems } from "./codex-rollout-items.js";
import { parseDurableTurnOutcomes, type DurableTurnOutcome } from "./codex-turn-outcomes.js";
import { recordedSubagentState, type RecordedAgentState } from "./codex-subagent-outcome.js";
import { TurnChangeTracker, type TurnChangeRecord } from "./turn-changes.js";
import { parseMcpStatusPage, type NativeMcpServer } from "./codex-mcp-status.js";
import { resolveSofiaPrompt } from "./sofia-commands.js";
// Codex session manager: owns a ManagedCodexEngine and exposes a small,
// Sofia-shaped session surface for the codex runtime. This is additive —
// engine routes are untouched. Each workspace gets its own engine process
// (mirroring how engine is managed per workspace) and threads are mapped to
// Sofia session ids via a `codex-<threadId>` scheme.
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, readdirSync, writeFileSync, openSync, closeSync, readSync, fstatSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, relative, isAbsolute } from "node:path";

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

function decodedThreadSource(metadata: Record<string, unknown>): Record<string, unknown> | null {
  let source = metadata.source;
  if (typeof source === "string") {
    try { source = JSON.parse(source); } catch { return null; }
  }
  return isRecord(source) ? source : null;
}

/** Child workers stay accessible by id, but are not independent user chats. */
export function isSubagentThread(metadata: Record<string, unknown>): boolean {
  const kind = metadata.threadSource ?? metadata.thread_source;
  if (kind === "subagent") return true;
  if (typeof metadata.source === "string" && /^sub[_-]?agent/i.test(metadata.source)) return true;
  const source = decodedThreadSource(metadata);
  return source !== null && (Object.hasOwn(source, "subagent") || Object.hasOwn(source, "subAgent"));
}

export function subagentParentSessionId(metadata: Record<string, unknown>): string | undefined {
  if (!isSubagentThread(metadata)) return undefined;
  const direct = metadata.parentThreadId ?? metadata.parent_thread_id;
  if (typeof direct === "string" && direct) return codexSessionId(direct);
  const source = decodedThreadSource(metadata);
  const agent = source?.subagent ?? source?.subAgent;
  if (!isRecord(agent)) return undefined;
  const spawn = agent.thread_spawn ?? agent.threadSpawn;
  if (!isRecord(spawn)) return undefined;
  const parent = spawn.parent_thread_id ?? spawn.parentThreadId;
  return typeof parent === "string" && parent ? codexSessionId(parent) : undefined;
}

function subagentIdentity(metadata: Record<string, unknown>): { agentNickname?: string; agentPath?: string } {
  const source = decodedThreadSource(metadata);
  const agent = source?.subagent ?? source?.subAgent;
  const spawn = isRecord(agent) ? agent.thread_spawn ?? agent.threadSpawn : null;
  const identity = isRecord(spawn) ? spawn : metadata;
  const nickname = identity.agentNickname ?? identity.agent_nickname;
  const path = identity.agentPath ?? identity.agent_path;
  return {
    ...(typeof nickname === "string" && nickname ? {agentNickname: nickname} : {}),
    ...(typeof path === "string" && path ? {agentPath: path} : {}),
  };
}

export function isRecordedSubagent(items: readonly { item: Record<string, unknown> }[], threadId: string): boolean {
  return items.some(({ item }) => item.type === "collabAgentToolCall" && isRecord(item.agentsStates) && Object.hasOwn(item.agentsStates, threadId));
}

/**
 * Hard cap on the items one transcript read returns. Threads longer than this
 * keep their most recent items; the engine has no "load older" API yet.
 */
export const MAX_TRANSCRIPT_ITEMS = 2000;

/**
 * Resolve the `beforeTurnId` that reverts a transcript to `messageId`.
 *
 * The engine reverts at a turn boundary only, so a message-level click is
 * mapped onto the turn that contains it: that turn and every later turn are
 * dropped. Returns null when nothing would remain — the message sits in the
 * first turn, is missing from the transcript, or there is no later turn to
 * anchor on (the message is in the newest turn, so there is nothing to drop).
 */
export function resolveRevertBoundary(
  items: Array<{ turnId: string; item: Record<string, unknown> }>,
  messageId: string,
): string | null {
  const turnIds: string[] = [];
  for (const entry of items) {
    if (entry.turnId && !turnIds.includes(entry.turnId)) turnIds.push(entry.turnId);
  }
  const boundaryTurnId = items.find((entry) => entry.item?.id === messageId)?.turnId;
  if (!boundaryTurnId) return null;
  const index = turnIds.indexOf(boundaryTurnId);
  if (index < 0) return null;
  // The engine drops `beforeTurnId` and everything after it, so anchor on the
  // boundary turn itself — it is excluded along with all later turns.
  //
  // A message in the first turn would leave no prefix at all. The engine keeps
  // no restore point (there is no unrevert primitive), so that would silently
  // destroy the whole transcript. Refuse instead: a thread with one turn has
  // nothing to rewind to.
  if (index === 0) return null;
  return boundaryTurnId;
}
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

export type CodexEngineHandle = {
  bin: string;
  cwd: string;
  codexHome?: string;
  skillRoots?: string[];
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
  /** Nested worker owner; normal chat list excludes these sessions. */
  parentSessionId?: string;
  agentNickname?: string;
  agentPath?: string;
  agentStatus?: RecordedAgentState["agentStatus"];
  agentUpdatedAt?: string;
  /** cwd of the last active turn (per-turn cwd tracking, like the app's turnCwds). */
  cwd?: string;
  /** Rollout JSONL path (legacy ChatGPT/Codex store) for transcript fallback. */
  rolloutPath?: string | null;
  model?: string;
  providerId?: string;
  /** Latest `update_plan` checklist, restored from the rollout on reopen. */
  plan?: CodexPlanItem[];
};

/** The desktop stamps a brand-new task with this title before the engine has
 * seen a turn. It must never mask the title the engine derives from the first
 * user message, and it must not be written to the engine's thread name where
 * every other client would then show it. */
function isPendingTaskTitle(value: string | null | undefined): boolean {
  return isPlaceholderTaskTitle(value);
}

/** Re-export the shared title formatter for existing server consumers. */
export { THREAD_TITLE_MAX_LENGTH, threadTitleFromEngineText } from "./codex-session-titles.js";

/**
 * A long-running command the agent started through unified exec. The engine
 * keeps these processes alive across turns, so the manager tracks them and
 * refuses to drop the thread subscription while any are live — a turn ending
 * is not evidence that the thread no longer owns work.
 *
 * `status` mirrors the engine's `CommandExecutionStatus`; a `running` process
 * is the only kind that retains the thread. `processId` is the engine handle
 * used by `thread/backgroundTerminals/terminate` (never an OS pid).
 */
export type BackgroundProcessStatus = "running" | "completed" | "failed" | "declined";

export type BackgroundProcess = {
  itemId: string;
  processId: string;
  command: string;
  /** Semantic operation title from the engine/orchestrator, when it supplies one. */
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

/**
 * Server-internal tracking record.
 *
 * Unified exec reports *every* shell command through a `CommandExecution`
 * item whose `source` is `unifiedExecStartup`, so the item alone does not make
 * a background process. Membership is earned, not assumed:
 *
 *   * a command still running when the turn that started it ends has outlived
 *     its turn — that is background work (`detached`), or
 *   * the engine's live terminal list names it (see `listBackgroundProcesses`),
 *
 * `turnId` records which turn started it so promotion can match the turn that
 * actually ended. Neither field is part of the wire shape.
 */
type TrackedProcess = BackgroundProcess & { detached: boolean; turnId?: string };

/** Drop the server's bookkeeping so the wire shape stays `BackgroundProcess`. */
function toWireProcess(tracked: TrackedProcess): BackgroundProcess {
  const { detached: _detached, turnId: _turnId, ...process } = tracked;
  return process;
}

/** Only `Startup` is a new process; an `Interaction` polls/writes one that
 * already exists and must not be registered as a background process. */
const UNIFIED_EXEC_STARTUP_SOURCE = "unifiedExecStartup";

/** One step of a Codex `update_plan` checklist. */
export type CodexPlanItem = { step: string; status: string };

/**
 * Codex reports step status as `pending` / `inProgress` / `completed` (the
 * app-server's camelCase wire form); the session UI speaks the Sofia todo
 * vocabulary (`pending` / `in_progress` / `completed` / `cancelled`). Normalize
 * here so every client sees one vocabulary.
 */
function normalizePlanStatus(status: unknown): string {
  switch (typeof status === "string" ? status.toLowerCase() : "") {
    case "inprogress":
    case "in_progress":
    case "in-progress":
    case "active":
    case "running":
      return "in_progress";
    case "completed":
    case "complete":
    case "done":
      return "completed";
    case "cancelled":
    case "canceled":
      return "cancelled";
    default:
      return "pending";
  }
}

/**
 * Parse an `update_plan` tool call's arguments (a JSON string in the rollout)
 * into normalized steps. Used to restore a checklist from the durable record.
 */
function parsePlanArguments(value: unknown): CodexPlanItem[] | null {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.plan)) return null;
  return parsed.plan
    .map((entry) => ({
      step: isRecord(entry) && typeof entry.step === "string" ? entry.step : "",
      status: normalizePlanStatus(isRecord(entry) ? entry.status : undefined),
    }))
    .filter((entry) => entry.step.trim().length > 0);
}

export type CodexQuestion = { id: string; sessionID: string; questions: { id: string; question: string; header: string; options: { label: string; description: string }[]; secret?: boolean; custom?: boolean }[]; isBlocking: boolean };

export type CodexEvent =
  | { type: "question.asked"; sessionId: string; properties: CodexQuestion }
  | { type: "question.rejected"; sessionId: string; properties: { sessionID: string; requestID: string } }
  | { type: "question.replied"; sessionId: string; properties: { sessionID: string; requestID: string } }
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
  | { type: "turn.changes"; sessionId: string; changes: TurnChangeRecord }
  | { type: "turn.completed"; sessionId: string; threadId: string; outcome?: "completed" | "cancelled" | "failed" }
  | { type: "plan.updated"; sessionId: string; threadId: string; turnId: string; explanation: string | null; plan: CodexPlanItem[] }
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

/**
 * Image payloads (data URLs) map to the engine's structured image input, so a
 * pasted image reaches the model as an image instead of base64 prompt text.
 */
function turnImageInputs(images?: readonly string[]): Array<{ url: string }> {
  return (images ?? []).map((url) => ({ url }));
}

/** Terminal status carried by a completed `CommandExecution` item. */
function backgroundStatusFromItem(item: Record<string, unknown>): BackgroundProcessStatus {
  const status = typeof item.status === "string" ? item.status : "";
  if (status === "failed") return "failed";
  if (status === "declined") return "declined";
  if (status === "completed") return "completed";
  return "running";
}

/** A process that stopped without being asked to: an explicit failure or a non-zero exit. */
export function isFailedBackgroundProcess(process: BackgroundProcess): boolean {
  if (process.status === "failed" || process.status === "declined") return true;
  return process.status === "completed" && typeof process.exitCode === "number" && process.exitCode !== 0;
}

/** Live processes first, then most-recently-started exit history. */
function sortBackgroundProcesses<T extends BackgroundProcess>(processes: T[]): T[] {
  return processes.sort((a, b) => {
    if (a.status === b.status) return a.itemId.localeCompare(b.itemId);
    return a.status === "running" ? -1 : 1;
  });
}

export class CodexSessionManager {
  private readonly turnChanges: TurnChangeTracker;
  private engine: ManagedCodexEngine | null = null;
  private sessions = new Map<string, CodexSession>();
  private childSessionIds = new Set<string>();
  private legacySubagentFingerprint = "";
  private pendingTitleInputs = new Map<string, string>();
  private namedThreads = new Set<string>();
  private titleIndexCache = new Map<string, { fingerprint: string; titles: Map<string, string> }>();
  private events = new EventEmitter();
  private starting: Promise<void> | null = null;
  private pendingQuestions = new Map<string, { requestId: string | number; question: CodexQuestion }>();
  private approvalQueue: { sessionId: string; threadId: string; params: unknown; resolve: () => void; reject: (reason?: unknown) => void }[] = [];
  private threadAliases: Record<string, string>;
  private loadedThreads = new Set<string>();
  /** Unified-exec background processes per thread, keyed by item id. */
  private backgroundProcesses = new Map<string, Map<string, TrackedProcess>>();
  private mcpConfigSnapshot: string | null = null;
  private mcpRefresh: Promise<void> = Promise.resolve();
  private skillRootsSnapshot: string | null = null;
  private skillRootsRefresh: Promise<void> = Promise.resolve();

  async setSkillRoots(roots: string[]): Promise<void> {
    this.handle.skillRoots = roots;
    const refresh = this.skillRootsRefresh.catch(() => undefined).then(async () => {
      if (!this.engine?.isAlive()) return;
      const current = this.handle.skillRoots ?? [];
      const snapshot = JSON.stringify(current);
      if (snapshot === this.skillRootsSnapshot) return;
      await this.engine.request("skills/extraRoots/set", { extraRoots: current });
      this.skillRootsSnapshot = snapshot;
    });
    this.skillRootsRefresh = refresh;
    await refresh;
  }

  async listDiscoveredSkills(): Promise<unknown> {
    await this.start();
    return this.activeEngine().request("skills/list", { cwds: [this.handle.cwd], forceReload: true });
  }

  /** Refresh loaded threads without terminating their active turns. */
  async refreshMcpConfiguration(): Promise<void> {
    const refresh = this.mcpRefresh.catch(() => undefined).then(async () => {
      const path = this.handle.env?.SOFIA_APP_CONFIG_FILE;
      if (!path || !this.engine?.isAlive()) return;
      const snapshot = readFileSync(path, "utf8");
      if (snapshot === this.mcpConfigSnapshot) return;
      await this.engine.request("config/mcpServer/reload");
      this.mcpConfigSnapshot = snapshot;
    });
    this.mcpRefresh = refresh;
    await refresh;
  }

  async listMcpServers(): Promise<NativeMcpServer[]> {
    await this.start();
    await this.refreshMcpConfiguration();
    const servers: NativeMcpServer[] = [];
    let cursor: string | null = null;
    const seen = new Set<string>();
    do {
      const page = parseMcpStatusPage(await this.activeEngine().request("mcpServerStatus/list", {
        cursor, limit: 100, detail: "toolsAndAuthOnly",
      }));
      servers.push(...page.data);
      cursor = page.nextCursor;
      if (cursor && seen.has(cursor)) throw new Error("Sofia MCP inventory repeated a page");
      if (cursor) seen.add(cursor);
    } while (cursor);
    return servers;
  }

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
    // Adopt external history into the Sofia home before taking a writer lease.
    // Resuming its source path directly would append to another app's rollout.
    if (session.rolloutPath && this.handle.codexHome) {
      const sourceRelative = relative(resolve(this.handle.codexHome), resolve(session.rolloutPath));
      if (sourceRelative === ".." || sourceRelative.startsWith("../") || isAbsolute(sourceRelative)) {
        const localId = await engine.forkThread({ threadId: session.threadId, path: session.rolloutPath, ...overrides, cwd: session.cwd ?? this.handle.cwd });
        if (!localId) throw new Error("Could not import this session into Sofia: the engine returned no thread ID.");
        const originalId = session.id.slice("codex-".length);
        session.threadId = localId;
        session.rolloutPath = this.findRolloutPath(localId);
        this.threadAliases[originalId] = localId;
        this.persistThreadAliases();
        this.loadedThreads.add(localId);
        return;
      }
    }
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

  /**
   * Retain the engine thread while it still owns live resources.
   *
   * A finished turn is not evidence that the thread is done: unified exec may
   * have left a dev server, watcher, or log tail running on it. Dropping the
   * subscription here would let the engine unload the thread after its idle
   * delay, which terminates every process it owns. Only once the last tracked
   * process exits may the thread become unload-eligible again.
   */
  private maybeReleaseThread(threadId: string): void {
    if (this.liveBackgroundProcesses(threadId).length > 0) return;
    this.releaseThread(threadId);
  }

  private backgroundProcessesFor(threadId: string): Map<string, TrackedProcess> {
    let processes = this.backgroundProcesses.get(threadId);
    if (!processes) {
      processes = new Map();
      this.backgroundProcesses.set(threadId, processes);
    }
    return processes;
  }

  /** Tracked processes that earned background-process membership. */
  private visibleProcesses(threadId: string): TrackedProcess[] {
    return [...this.backgroundProcessesFor(threadId).values()]
      .filter((process) => process.detached);
  }

  /**
   * Retain the engine thread while a *detached* process still owns it. A
   * command merely running inside the current turn is not a reason to keep the
   * subscription past the turn — the turn itself already does that.
   */
  private liveBackgroundProcesses(threadId: string): TrackedProcess[] {
    return this.visibleProcesses(threadId).filter((process) => process.status === "running");
  }

  /** Map a unified-exec `CommandExecution` item onto a tracked process. */
  private backgroundProcessFromItem(item: Record<string, unknown>): BackgroundProcess | null {
    const source = typeof item.source === "string" ? item.source : "";
    if (source !== UNIFIED_EXEC_STARTUP_SOURCE) return null;
    const itemId = typeof item.id === "string" ? item.id : "";
    if (!itemId) return null;
    const title = typeof item.description === "string" ? item.description.trim() : "";
    return {
      itemId,
      processId: typeof item.processId === "string" ? item.processId : "",
      command: typeof item.command === "string" ? item.command : "",
      ...(title ? { title } : {}),
      cwd: typeof item.cwd === "string" ? item.cwd : undefined,
      status: "running",
    };
  }


  private setupEngineListeners(engine: ManagedCodexEngine): void {
    // Inbound server->client approval requests must be answered with a response.
    const onReq = (request: unknown) => {
      const r = request as Record<string, unknown>;
      const method = r.method as string;
      if (method === "item/tool/requestUserInput" && (typeof r.id === "string" || typeof r.id === "number") && isRecord(r.params)) {
        const params = r.params;
        const session = typeof params.threadId === "string" ? this.sessionFor(params.threadId) : undefined;
        if (!session || !Array.isArray(params.questions)) return;
        const questions = params.questions.filter(isRecord).map(q => ({
          id: typeof q.id === "string" ? q.id : "",
          question: typeof q.question === "string" ? q.question : "",
          header: typeof q.header === "string" ? q.header : "",
          options: Array.isArray(q.options) ? q.options.filter(isRecord).map(o => ({ label: String(o.label ?? ""), description: String(o.description ?? "") })) : [],
          secret: q.isSecret === true,
          custom: true,
        }));
        const question: CodexQuestion = { id: String(r.id), sessionID: session.id, questions, isBlocking: params.isBlocking !== false };
        this.pendingQuestions.set(question.id, { requestId: r.id, question });
        this.emit({ type: "question.asked", sessionId: session.id, properties: question });
        return;
      }
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
    engine.on("serverRequest/resolved", params => {
      if (!isRecord(params)) return;
      const id = String(params.requestId);
      const pending = this.pendingQuestions.get(id);
      const session = typeof params.threadId === "string" ? this.sessionFor(params.threadId) : null;
      if (!pending || session?.id !== pending.question.sessionID) return;
      this.pendingQuestions.delete(id);
      this.emit({ type: "question.rejected", sessionId: session.id, properties: { sessionID: session.id, requestID: id } });
    });
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
    this.turnChanges = new TurnChangeTracker(handle.codexHome ? join(handle.codexHome, "sofia-turn-changes") : null);
  }

  getTurnChanges(sessionId: string): Promise<TurnChangeRecord[]> {
    return this.turnChanges.list(sessionId);
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
    this.refreshIndexedTitles();
    return [...this.sessions.values()].filter(session => !this.childSessionIds.has(session.id)).sort((a, b) => b.created.localeCompare(a.created));
  }

  getSession(sessionId: string): CodexSession | null {
    this.refreshIndexedTitles();
    return this.sessions.get(sessionId) ?? null;
  }

  /** Read desktop display names on list/open, so a renamed imported thread
   * appears without restarting the workspace manager. Match exact root ids. */
  private refreshIndexedTitles(): void {
    if (!this.enableLegacyImport) return;
    const realHome = this.handle.env?.REAL_HOME?.trim() || process.env.REAL_HOME?.trim() || homedir();
    const indexedTitles = new Map<string, string>();
    for (const home of new Set([homedir(), realHome])) {
      const path = join(home, ".codex", "session_index.jsonl");
      try {
        const stat = statSync(path);
        const fingerprint = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
        let cached = this.titleIndexCache.get(path);
        if (cached?.fingerprint !== fingerprint) {
          cached = { fingerprint, titles: parseCodexSessionTitles(readFileSync(path, "utf8")) };
          this.titleIndexCache.set(path, cached);
        }
        if (cached) for (const [id, title] of cached.titles) indexedTitles.set(id, title);
      } catch { /* Missing or partially replaced index is retried on next read. */ }
    }
    for (const session of this.sessions.values()) {
      if (this.namedThreads.has(session.threadId)) continue;
      const title = indexedTitles.get(session.threadId);
      if (!title || title === session.title) continue;
      session.title = title;
      this.emit({ type: "session.updated", session: { ...session } });
    }
  }

  /**
   * The last `update_plan` checklist written to a thread's rollout. The engine
   * neither persists the checklist as an item nor replays it on resume, so the
   * rollout is the durable record a reopened task restores from.
   */
  private readLatestPlanFromRollout(session: CodexSession): CodexPlanItem[] | null {
    const path = session.rolloutPath ?? this.findRolloutPath(session.threadId);
    if (!path || !existsSync(path)) return null;
    session.rolloutPath = path;
    try {
      let latest: CodexPlanItem[] | null = null;
      for (const line of readRolloutLines(path)) {
        if (!line.includes("update_plan")) continue;
        let parsed: Record<string, unknown>;
        try { parsed = JSON.parse(line); } catch { continue; }
        if (parsed.type !== "response_item") continue;
        const payload = isRecord(parsed.payload) ? parsed.payload : {};
        if (payload.type !== "function_call" || payload.name !== "update_plan") continue;
        const steps = parsePlanArguments(payload.arguments);
        if (steps) latest = steps;
      }
      return latest;
    } catch {
      return null;
    }
  }

  /** A session's checklist: the live value, else the rollout's record. */
  async getSessionPlan(sessionId: string): Promise<CodexPlanItem[] | null> {
    await this.start();
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    const plan = session.plan ?? this.readLatestPlanFromRollout(session);
    if (!plan) return null;
    session.plan = plan;
    // Restore is conservative: a fully completed checklist is the normal end
    // state (and Codex treats the plan as transient), so a reopened task must
    // not resurrect a finished one. Only an in-flight checklist is restored.
    return plan.some((step) => step.status !== "completed") ? plan : null;
  }

  private subagentOutcomeCache = new Map<string, { fingerprint: string; state: RecordedAgentState }>();

  /** Recorded direct workers; idle means no observed live turn, not done. */
  getSubagents(parentSessionId: string): CodexSession[] {
    return [...this.sessions.values()]
      .filter(session => session.parentSessionId === parentSessionId)
      .map(session => {
        let recorded: RecordedAgentState = {agentStatus: "unknown"};
        const path = session.rolloutPath ?? this.findRolloutPath(session.threadId);
        let fd: number | undefined;
        try {
          if (path) {
            fd = openSync(path, "r");
            const size = fstatSync(fd).size;
            const stat = fstatSync(fd);
            const fingerprint = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
            const cached = this.subagentOutcomeCache.get(path);
            if (cached?.fingerprint === fingerprint) recorded = cached.state;
            else {
              const length = Math.min(size, 8 * 1024 * 1024);
              const buffer = Buffer.alloc(length);
              const read = readSync(fd, buffer, 0, length, size - length);
              recorded = recordedSubagentState(buffer.subarray(0, read).toString("utf8"));
              this.subagentOutcomeCache.set(path, {fingerprint, state: recorded});
            }
          }
        } catch { /* A missing record remains unknown. */ }
        finally { if (fd !== undefined) closeSync(fd); }
        return {...session, ...recorded, ...(session.status === "running" ? {agentStatus: "working" as const} : session.status === "error" ? {agentStatus: "failed" as const} : {})};
      });
  }

  /** Discover externally spawned workers from metadata only; never resume. */
  async refreshSubagents(parentSessionId: string): Promise<CodexSession[]> {
    await this.start();
    if (this.enableLegacyImport) {
      const realHome = this.handle.env?.REAL_HOME?.trim() || process.env.REAL_HOME?.trim() || homedir();
      const sources = [...new Set([realHome, homedir()])].flatMap(home => {
        const db = join(home, ".codex", "state_5.sqlite");
        return [db, `${db}-wal`];
      });
      const fingerprint = sources.map(path => {
        try {
          const stat = statSync(path);
          return `${path}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
        } catch { return `${path}:absent`; }
      }).join("|");
      if (fingerprint !== this.legacySubagentFingerprint) {
        await this.importLegacyCodexSessions();
        this.legacySubagentFingerprint = fingerprint;
      }
    }
    // Native workers are excluded from the ordinary chat list. Discover them
    // separately without resuming a thread or taking its writer lock.
    try {
      const threads = await this.activeEngine().listThreads({ limit: 100, archived: false, sourceKinds: ["subAgentThreadSpawn"] });
      for (const listed of threads) {
        if (typeof listed.id !== "string" || !isSubagentThread(listed)) continue;
        let metadata = listed;
        const listedParent = subagentParentSessionId(listed);
        if (listedParent && listedParent !== parentSessionId) continue;
        try {
          const read = await this.activeEngine().readThread(listed.id);
          if (isRecord(read) && isRecord(read.thread)) metadata = { ...listed, ...read.thread };
        } catch { /* List metadata is sufficient when read is unavailable. */ }
        if (subagentParentSessionId(metadata) !== parentSessionId) continue;
        const id = codexSessionId(listed.id);
        const previous = this.sessions.get(id);
        this.childSessionIds.add(id);
        const createdAt = metadata.createdAt;
        const identity = subagentIdentity(metadata);
        const taskName = identity.agentPath?.split("/").filter(Boolean).at(-1)?.replace(/[_-]+/g, " ");
        const title = selectCodexThreadName(metadata) || (taskName ? taskName.charAt(0).toUpperCase() + taskName.slice(1) : previous?.title || identity.agentNickname || "Subagent");
        this.sessions.set(id, {
          ...previous,
          id,
          threadId: listed.id,
          parentSessionId,
          title,
          cwd: typeof metadata.cwd === "string" ? metadata.cwd : this.handle.cwd,
          workspaceId: this.workspaceId ?? "local",
          created: previous?.created ?? (typeof createdAt === "number" ? new Date(createdAt * 1000).toISOString() : new Date().toISOString()),
          turnId: previous?.turnId ?? null,
          status: previous?.status ?? "idle",
          ...identity,
          ...(typeof metadata.rolloutPath === "string" ? { rolloutPath: metadata.rolloutPath } : {}),
        });
      }
    } catch { /* Older engines can lack this source filter; preserve recorded workers. */ }
    return this.getSubagents(parentSessionId);
  }

  /** Browse a recorded child without resuming it or acquiring its writer lock. */
  async getSubagentItems(parentSessionId: string, threadId: string) {
    const parentItems = await this.getSessionItems(parentSessionId);
    const child = this.getSession(codexSessionId(threadId));
    if (child?.parentSessionId !== parentSessionId && !isRecordedSubagent(parentItems, threadId)) {
      throw new Error("This thread is not a recorded subagent of this session");
    }
    if (child) {
      const items = await this.getSessionItems(child.id);
      let bornAt = NaN;
      const path = child.rolloutPath ?? this.findRolloutPath(child.threadId);
      let fd: number | undefined;
      try {
        if (path) {
          fd = openSync(path, "r");
          const buffer = Buffer.alloc(Math.min(fstatSync(fd).size, 64 * 1024));
          const read = readSync(fd, buffer, 0, buffer.length, 0);
          for (const line of buffer.subarray(0, read).toString("utf8").split("\n")) {
            let record: unknown;
            try { record = JSON.parse(line); } catch { continue; }
            if (isRecord(record) && record.type === "session_meta" && isRecord(record.payload) && record.payload.id === child.threadId && typeof record.payload.timestamp === "string") {
              bornAt = Date.parse(record.payload.timestamp); break;
            }
          }
        }
      } catch { /* Without an owned boundary, keep recorded data. */ }
      finally { if (fd !== undefined) closeSync(fd); }
      const outcomes = await this.getTurnOutcomes(child.id);
      return items.filter(entry => !Number.isFinite(bornAt) || (typeof entry.item.createdAt === "number" && entry.item.createdAt >= bornAt)).map(entry => {
        const outcome = outcomes.find(outcome => outcome.turnId === entry.turnId);
        return {...entry,item:{...entry.item,...(outcome?.startedAt === undefined ? {} : {turnStartedAt:outcome.startedAt}),...(outcome?.completedAt === undefined ? {} : {turnCompletedAt:outcome.completedAt})}};
      });
    }
    if (!this.engine) throw new Error("Engine unavailable");
    return this.readThreadStoreItems(this.engine, threadId, MAX_TRANSCRIPT_ITEMS);
  }

  /** Fetch a thread's persisted items (for restoring a transcript). */
  private readonly transcriptReads = new Map<string, Promise<Array<{ turnId: string; item: Record<string, unknown> }>>>();

  getSessionItems(sessionId: string, options?: { limit?: number }): Promise<Array<{ turnId: string; item: Record<string, unknown> }>> {
    const limit = Math.min(MAX_TRANSCRIPT_ITEMS, Math.max(1, Math.floor(options?.limit || MAX_TRANSCRIPT_ITEMS)));
    const key = `${sessionId}:${limit}`;
    const pending = this.transcriptReads.get(key);
    if (pending) return pending;
    const request = historyReadScheduler.run(() => this.readSessionItems(sessionId, { limit }));
    this.transcriptReads.set(key, request);
    void request.finally(() => {
      if (this.transcriptReads.get(key) === request) this.transcriptReads.delete(key);
    }).catch(() => undefined);
    return request;
  }

  private async readSessionItems(sessionId: string, options?: { limit?: number }): Promise<Array<{ turnId: string; item: Record<string, unknown> }>> {
    await this.start();
    this.refreshIndexedTitles();
    const session = this.sessions.get(sessionId);
    const engine = this.engine;
    if (!session || !engine) return [];
    const limit = Math.min(MAX_TRANSCRIPT_ITEMS, Math.max(1, Math.floor(options?.limit || MAX_TRANSCRIPT_ITEMS)));
    // Read-only by design: `thread/items/list` serves materialized items
    // straight from the thread store, and the rollout JSONL covers threads the
    // store has not seen. Never resume here — resuming takes the thread's
    // exclusive writer lock and subscribes this connection, which kept every
    // browsed session locked against other Sofia processes until we exited.
    try {
      const items = await this.readThreadStoreItems(engine, session.threadId, limit);
      if (items.length > 0) {
        return reconcileRolloutItems(this.readRolloutItems(session, limit), items);
      }
    } catch (error) {
      if (error instanceof RolloutRecordTooLargeError) throw error;
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
    let retainedChars = 0;
    const sizes: number[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < TRANSCRIPT_PAGE_BUDGET; page += 1) {
      const result = await engine.listThreadItems(threadId, {
        limit: TRANSCRIPT_PAGE_SIZE,
        ...(cursor ? { cursor } : {}),
      });
      for (const entry of result.items) {
        items.push(entry);
        const size = JSON.stringify(entry.item).length;
        sizes.push(size);
        retainedChars += size;
        while (items.length > 1 && (items.length > limit || retainedChars > TRANSCRIPT_RETAINED_CHARS)) {
          items.shift();
          retainedChars -= sizes.shift()!;
        }
      }
      if (!result.nextCursor || result.items.length === 0) break;
      cursor = result.nextCursor;
    }
    return items;
  }

  /** Parse a legacy rollout JSONL into ThreadItem-shaped entries. */
  async getTurnOutcomes(sessionId: string): Promise<DurableTurnOutcome[]> {
    const session = this.sessions.get(sessionId);
    if (!session) return [];
    const path = session.rolloutPath ?? this.findRolloutPath(session.threadId);
    if (!path || !existsSync(path)) return [];
    let fd: number | undefined;
    try {
      fd = openSync(path, "r");
      const size = fstatSync(fd).size;
      const length = Math.min(size, 8 * 1024 * 1024);
      const buffer = Buffer.alloc(length);
      const read = readSync(fd, buffer, 0, length, size - length);
      return parseDurableTurnOutcomes(buffer.subarray(0, read).toString("utf8"));
    } catch {
      return [];
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  private readRolloutItems(session: CodexSession, limit = 200): Array<{ turnId: string; item: Record<string, unknown> }> {
    const path = session.rolloutPath ?? this.findRolloutPath(session.threadId);
    if (!path || !existsSync(path)) return [];
    session.rolloutPath = path;
    try {
      return parseRolloutLines(readRolloutLines(path), limit);
    } catch (error) {
      if (error instanceof RolloutRecordTooLargeError) throw error;
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
      this.backgroundProcesses.clear();
    this.pendingTitleInputs.clear();
    this.namedThreads.clear();
      const engine = new ManagedCodexEngine({
        bin: this.handle.bin,        cwd: this.handle.cwd,
        codexHome: this.handle.codexHome,
        env: this.handle.env,
        interpreter: this.handle.interpreter,
      });
      await engine.initialize();
      this.setupEngineListeners(engine);
      engine.onExit(() => {
        // The engine owns every background process; none survive its exit.
        this.backgroundProcesses.clear();
    this.pendingTitleInputs.clear();
    this.namedThreads.clear();
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
      engine.on("turn/plan/updated", (params) => this.handlePlanUpdated(params));
      engine.on("thread/status/changed", (params) => this.handleThreadStatus(params));
      engine.on("account/rateLimits/updated", (params) => this.handleRateLimits(params));
      // Notification-style (no request id) approval requests, e.g. when the
      // server streams a pending approval as a notification.
      engine.on("item/permissions/requestApproval", (params) => this.handleApproval(params));
      engine.on("item/commandExecution/requestApproval", (params) => this.handleApproval(params));
      engine.on("item/fileChange/requestApproval", (params) => this.handleApproval(params));
      this.engine = engine;
      this.skillRootsSnapshot = null;
      await this.setSkillRoots(this.handle.skillRoots ?? []);
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
      const threads = await this.engine.listThreads({ limit: 100, archived: false, sourceKinds: ["cli", "vscode", "exec", "appServer", "unknown"] });
      for (const raw of threads) {
        const thread = raw as {
          id?: string;
          preview?: string;
          name?: string;
          title?: string;
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
        if (isSubagentThread(raw)) this.childSessionIds.add(codexSessionId(threadId));
        // Group by project, not exact path: a session created in a subdirectory
        // (or from the repo root while the workspace points at a subdir) belongs
        // to this workspace, and the TUI lists it. Strict equality hid them.
        if (!threadBelongsToWorkspace(this.handle.cwd, thread.cwd)) continue;
        if (selectCodexThreadName({ name: thread.name })) this.namedThreads.add(threadId);
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
          parentSessionId: subagentParentSessionId(raw),
          ...subagentIdentity(raw),
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
    const realHome = this.handle.env?.REAL_HOME?.trim() || process.env.REAL_HOME?.trim() || homedir();
    const candidates = [
      join(realHome, ".codex", "state_5.sqlite"),
      join(homedir(), ".codex", "state_5.sqlite"),
    ];
    for (const candidate of candidates) {
      try {
        if (existsSync(candidate)) { legacyDb = candidate; break; }
      } catch { /* skip */ }
    }
    const indexedTitles = new Map<string, string>();
    for (const home of new Set([homedir(), realHome])) {
      try {
        for (const [id, title] of parseCodexSessionTitles(readFileSync(join(home, ".codex", "session_index.jsonl"), "utf8"))) indexedTitles.set(id, title);
      } catch { /* Desktop names are optional; never mutate their source. */ }
    }
    for (const session of this.sessions.values()) {
      const title = indexedTitles.get(session.threadId);
      if (title && !this.namedThreads.has(session.threadId)) session.title = title;
    }
    if (!legacyDb) return;
    try {
      const { DatabaseSync } = await importNodeSqlite();
      const sqlite = new DatabaseSync(legacyDb, { readOnly: true });
      const rows = sqlite.prepare(
        "SELECT * FROM threads",
      ).all() as Array<Record<string, unknown>>;
      sqlite.close();
      const workspacePath = this.handle.cwd;
      for (const row of rows) {
        const threadId = typeof row.id === "string" ? row.id : "";
        if (!threadId) continue;
        if (isSubagentThread(row)) this.childSessionIds.add(codexSessionId(threadId));
        if (row.archived === 1) continue;
        const existing = this.sessions.get(codexSessionId(threadId));
        if (existing) {
          const parentSessionId = subagentParentSessionId(row);
          if (parentSessionId) {
            existing.parentSessionId = parentSessionId;
            Object.assign(existing, subagentIdentity(row));
          }
          if (isPendingTaskTitle(existing.title)) existing.title = indexedTitles.get(threadId) ?? (threadTitleFromEngineText(row.title) || "Sofia task");
          continue;
        }
        // Only import sessions whose project matches this workspace's path
        // (codex groups by project cwd; Sofia groups by workspace).
        const rowCwd = typeof row.cwd === "string" ? row.cwd : "";
        if (workspacePath && rowCwd && !pathsMatch(workspacePath, rowCwd)) continue;
        const createdRaw = row.created_at;
        const created = typeof createdRaw === "number"
          ? new Date(createdRaw * 1000).toISOString()
          : new Date().toISOString();
        const session: CodexSession = {
          id: codexSessionId(threadId),
          parentSessionId: subagentParentSessionId(row),
          ...subagentIdentity(row),
          threadId: this.threadAliases[threadId] ?? threadId,
          title: indexedTitles.get(threadId) ?? (threadDisplayTitle({name: typeof row.name === "string" ? row.name : undefined, title: typeof row.title === "string" ? row.title : undefined, preview: typeof row.first_user_message === "string" ? row.first_user_message : undefined}) || "Sofia task"),
          workspaceId: this.workspaceId ?? "local",
          created,
          turnId: null,
          status: "idle",
          rolloutPath: this.threadAliases[threadId]
            ? this.findRolloutPath(this.threadAliases[threadId])
            : typeof row.rollout_path === "string" ? row.rollout_path : null,
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
    this.backgroundProcesses.clear();
    this.pendingTitleInputs.clear();
    this.namedThreads.clear();
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
      this.namedThreads.add(threadId);
    }
    this.sessions.set(session.id, session);
    this.emit({ type: "session.created", session });
    if (input.prompt) {
      await this.prompt(session.id, input.prompt);
    }
    return { ...session };
  }

  /** Submit a user message to a thread and start a turn. */
  async prompt(sessionId: string, text: string, opts?: { cwd?: string; model?: string; providerId?: string; images?: string[] }): Promise<CodexSession> {
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
    if (isPendingTaskTitle(session.title) && !this.pendingTitleInputs.has(session.id)) this.pendingTitleInputs.set(session.id, text);
    // Reserve the task before any RPC so concurrent prompts cannot start two turns.
    session.status = "running";
    session.cwd = opts?.cwd ?? session.cwd ?? this.handle.cwd;
    this.emit({ type: "session.updated", session: { ...session } });
    let turnId: string | null;
    try {
      await this.loadThread(session, engine, opts);
      if ((opts?.model && opts.model !== session.model) || (opts?.providerId && opts.providerId !== session.providerId)) {
        // Provider and model are one selection, not two: a model id only means
        // something relative to the provider that serves it. Sending just
        // `modelProvider` leaves the engine's previously configured `model` in
        // place, so the provider flips while the stale model id survives —
        // e.g. DeepSeek receiving OpenRouter's `stealth/space-bunny-alpha`.
        // Resolve the pair once and send it together.
        const nextModel = opts?.model ?? session.model;
        const nextProvider = opts?.providerId ?? session.providerId;
        await engine.updateThreadSettings({
          threadId: session.threadId,
          ...(nextModel ? { model: nextModel } : {}),
          ...(nextProvider ? { modelProvider: nextProvider } : {}),
        });
        if (opts.model) session.model = opts.model;
        if (opts.providerId) session.providerId = opts.providerId;
      }
      await this.turnChanges.beginTurn(session.id, session.cwd);
      // Never send an empty text input: an image-only turn carries its payload
      // as an image input, and a `{ text: "" }` entry is rejected outright
      // ("text is required"). Only the text the caller actually has is sent.
      const promptText = text.trim() ? await resolveSofiaPrompt(session.cwd, text) : "";
      const imageInputs = turnImageInputs(opts?.images);
      if (!promptText && imageInputs.length === 0) throw new Error("text is required");
      turnId = await engine.startTurn({
        ...codexTurnPermissions(readCodexAccessMode(this.handle.codexHome)),
        threadId: session.threadId,
        input: [...(promptText ? [{ text: promptText }] : []), ...imageInputs],
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
  async steer(sessionId: string, text: string, images?: string[]): Promise<CodexSession> {
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
        input: [{ text }, ...turnImageInputs(images)],
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

  /**
   * Branch a session into a new thread (thread/fork).
   *
   * `messageId` is the boundary message from the transcript: the fork keeps the
   * conversation up to but excluding that message's turn, matching the legacy
   * engine's message-boundary fork. Without a boundary the whole thread forks.
   */
  async forkSession(sessionId: string, options?: { messageId?: string | null }): Promise<CodexSession> {
    await this.start();
    const session = this.sessions.get(sessionId);
    if (!session || !this.engine) throw new Error(`unknown Sofia session: ${sessionId}`);
    const bounds = options?.messageId
      ? await this.forkBoundsForMessage(session, options.messageId)
      : {};
    const newThreadId = await this.engine.forkThread({ threadId: session.threadId, ...bounds });
    if (!newThreadId) throw new Error("thread/fork returned no threadId");
    const forked: CodexSession = {
      id: codexSessionId(newThreadId),
      threadId: newThreadId,
      title: `${session.title} (branch)`,
      workspaceId: session.workspaceId,
      created: new Date().toISOString(),
      turnId: null,
      status: "idle",
      cwd: session.cwd ?? this.handle.cwd,
    };
    this.sessions.set(forked.id, forked);
    this.emit({ type: "session.created", session: forked });
    return { ...forked };
  }

  /**
   * Turn bounds that drop the boundary message's turn and everything after it.
   * The engine has no message-level fork, so the transcript is mapped onto the
   * turn boundary the protocol exposes.
   */
  private async forkBoundsForMessage(
    session: CodexSession,
    messageId: string,
  ): Promise<{ lastTurnId?: string; beforeTurnId?: string }> {
    let items: Array<{ turnId: string; item: Record<string, unknown> }>;
    try {
      items = await this.getSessionItems(session.id, { limit: MAX_TRANSCRIPT_ITEMS });
    } catch {
      return {};
    }
    const turnIds: string[] = [];
    for (const entry of items) {
      if (entry.turnId && !turnIds.includes(entry.turnId)) turnIds.push(entry.turnId);
    }
    const boundaryTurnId = items.find((entry) => entry.item?.id === messageId)?.turnId;
    if (!boundaryTurnId) return {};
    const index = turnIds.indexOf(boundaryTurnId);
    // Branching before the first turn keeps nothing, so fork before it.
    return index > 0
      ? { lastTurnId: turnIds[index - 1] }
      : { beforeTurnId: boundaryTurnId };
  }

  /**
   * Revert a session to the history before one message's turn (thread/revert).
   *
   * `messageId` is the boundary message from the transcript: the session keeps
   * the conversation up to but excluding that message's turn, so the user
   * message and everything the assistant said after it are dropped. Like
   * fork, the transcript is mapped onto the turn boundary the protocol
   * exposes, because the engine has no message-level revert.
   */
  async revertSession(sessionId: string, options: { messageId: string }): Promise<CodexSession> {
    await this.start();
    const session = this.sessions.get(sessionId);
    if (!session || !this.engine) throw new Error(`unknown Sofia session: ${sessionId}`);
    let items: Array<{ turnId: string; item: Record<string, unknown> }>;
    try {
      items = await this.getSessionItems(session.id, { limit: MAX_TRANSCRIPT_ITEMS });
    } catch (error) {
      throw new Error(`failed to read transcript for revert: ${String(error)}`);
    }
    const beforeTurnId = resolveRevertBoundary(items, options.messageId);
    if (!beforeTurnId) throw new Error("nothing to revert at this message");
    await this.engine.revertThread({ threadId: session.threadId, beforeTurnId });
    // The engine points the thread at a replacement rollout, so the cached
    // transcript is now stale; the client re-reads the rewound history.
    session.turnId = null;
    session.status = "idle";
    this.emit({ type: "session.updated", session: { ...session } });
    return { ...session };
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
    this.namedThreads.add(session.threadId);
    this.pendingTitleInputs.delete(session.id);
    this.emit({ type: "session.updated", session: { ...session } });
    return { ...session };
  }

  /** Background processes tracked for a session, live ones first. */
  listTrackedBackgroundProcesses(sessionId: string): BackgroundProcess[] {
    const session = this.sessions.get(sessionId);
    if (!session) return [];
    return sortBackgroundProcesses(this.visibleProcesses(session.threadId)).map(toWireProcess);
  }

  /**
   * Merged background-process view: the server registry (which has status,
   * exit code, output, and duration from the item stream) reconciled against
   * the engine's live list. The engine only reports processes that are still
   * running, so a locally running process the engine no longer lists is marked
   * completed. Reconciliation needs the thread loaded; an unloaded thread (or
   * an older engine) falls back to the local view without failing.
   */
  async listBackgroundProcesses(sessionId: string): Promise<BackgroundProcess[]> {
    await this.start();
    this.refreshIndexedTitles();
    const session = this.sessions.get(sessionId);
    const engine = this.engine;
    if (!session || !engine) return [];
    const tracked = this.backgroundProcessesFor(session.threadId);
    try {
      const live = await engine.request("thread/backgroundTerminals/list", { threadId: session.threadId });
      const entries = isRecord(live) && Array.isArray(live.data) ? live.data : [];
      const liveIds = new Set<string>();
      for (const entry of entries) {
        if (!isRecord(entry)) continue;
        const itemId = typeof entry.itemId === "string" ? entry.itemId : "";
        const processId = typeof entry.processId === "string" ? entry.processId : "";
        const key = itemId || processId;
        if (!key) continue;
        const existing = [...tracked.values()].find((process) =>
          (itemId && process.itemId === itemId) || (processId && process.processId === processId));
        // Engine-discovered terminals have no tracked record: the engine lists
        // only live terminals, so they are detached by definition.
        const target: TrackedProcess = existing ?? { itemId: itemId || key, processId, command: "", status: "running", detached: true };
        target.status = "running";
        if (!target.processId && processId) target.processId = processId;
        if (!target.itemId && itemId) target.itemId = itemId;
        if (typeof entry.command === "string" && entry.command) target.command = entry.command;
        if (typeof entry.cwd === "string" && entry.cwd) target.cwd = entry.cwd;
        if (typeof entry.osPid === "number") target.osPid = entry.osPid;
        if (typeof entry.cpuPercent === "number") target.cpuPercent = entry.cpuPercent;
        if (typeof entry.rssKb === "number") target.rssKb = entry.rssKb;
        if (!existing) tracked.set(target.itemId, target);
        liveIds.add(target.itemId);
      }
      for (const process of tracked.values()) {
        if (process.detached && process.status === "running" && !liveIds.has(process.itemId)) process.status = "completed";
      }
    } catch {
      // Thread unloaded or engine unavailable — the local view still helps.
    }
    return sortBackgroundProcesses(this.visibleProcesses(session.threadId)).map(toWireProcess);
  }

  /**
   * Terminate one background process (thread/backgroundTerminals/terminate).
   * `identifier` may be the engine `processId` or the item id so the UI can
   * address a process even when the item never carried a process id.
   */
  async terminateBackgroundProcess(sessionId: string, identifier: string): Promise<boolean> {
    await this.start();
    const session = this.sessions.get(sessionId);
    const engine = this.engine;
    if (!session || !engine || !identifier) return false;
    const tracked = this.backgroundProcessesFor(session.threadId);
    const process = [...tracked.values()].find((entry) =>
      entry.processId === identifier || entry.itemId === identifier);
    const processId = process?.processId || identifier;
    const result = await engine.request("thread/backgroundTerminals/terminate", {
      threadId: session.threadId,
      processId,
    }).catch(() => null);
    const terminated = isRecord(result) && result.terminated === true;
    if (terminated && process) {
      process.status = "completed";
      this.emitBackgroundProcesses(session.id);
      if (session.status !== "running") this.maybeReleaseThread(session.threadId);
    }
    return terminated;
  }

  /** Stop every background process on a thread (thread/backgroundTerminals/clean). */
  async cleanBackgroundProcesses(sessionId: string): Promise<void> {
    await this.start();
    const session = this.sessions.get(sessionId);
    const engine = this.engine;
    if (!session || !engine) return;
    await engine.request("thread/backgroundTerminals/clean", { threadId: session.threadId }).catch(() => undefined);
    const tracked = this.backgroundProcessesFor(session.threadId);
    let changed = false;
    for (const process of tracked.values()) {
      if (process.detached && process.status === "running") {
        process.status = "completed";
        changed = true;
      }
    }
    if (changed) this.emitBackgroundProcesses(session.id);
    if (session.status !== "running") this.maybeReleaseThread(session.threadId);
  }

  private emitBackgroundProcesses(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.emit({
      type: "backgroundProcesses",
      sessionId,
      threadId: session.threadId,
      processes: sortBackgroundProcesses(this.visibleProcesses(session.threadId)).map(toWireProcess),
    });
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
    this.backgroundProcesses.delete(session.threadId);
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
    if (itemType === "commandExecution" && isRecord(item)) {
      const process = this.backgroundProcessFromItem(item);
      if (process?.processId) {
        // Registered, but not yet a background process. It earns membership by
        // still running when this turn ends; nothing is emitted until then, so
        // an ordinary command never reaches the client as background work.
        this.backgroundProcessesFor(session.threadId).set(process.itemId, {
          ...process,
          detached: false,
          ...(typeof turnId === "string" && turnId ? { turnId } : {}),
        });
      }
    }
    this.emit({ type: "item.started", sessionId: session.id, threadId: threadId ?? "", itemType, item: item ?? null, turnId: typeof turnId === "string" ? turnId : "" });
  }

  /**
   * Codex's `update_plan` checklist: the engine emits this notification as the
   * model rewrites its plan, but it is not an item, so without an explicit
   * subscription the checklist never reaches the session UI.
   */
  private handlePlanUpdated(params: unknown): void {
    if (!params || typeof params !== "object") return;
    const { threadId, turnId, explanation, plan } = params as {
      threadId?: string;
      turnId?: string;
      explanation?: string | null;
      plan?: Array<{ step?: unknown; status?: unknown }>;
    };
    const session = this.sessionFor(threadId ?? "");
    if (!session) return;
    const steps: CodexPlanItem[] = Array.isArray(plan)
      ? plan
          .map((entry) => ({
            step: typeof entry?.step === "string" ? entry.step : "",
            status: normalizePlanStatus(entry?.status),
          }))
          .filter((entry) => entry.step.trim().length > 0)
      : [];
    session.plan = steps;
    this.emit({
      type: "plan.updated",
      sessionId: session.id,
      threadId: threadId ?? "",
      turnId: typeof turnId === "string" ? turnId : "",
      explanation: typeof explanation === "string" && explanation.trim() ? explanation : null,
      plan: steps,
    });
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
    let processExited = false;
    if (itemType === "commandExecution" && isRecord(item)) {
      const itemId = typeof item.id === "string" ? item.id : "";
      const tracked = itemId ? this.backgroundProcessesFor(session.threadId).get(itemId) : undefined;
      if (tracked) {
        const wasRunning = tracked.status === "running";
        tracked.status = backgroundStatusFromItem(item);
        if (typeof item.exitCode === "number") tracked.exitCode = item.exitCode;
        if (typeof item.aggregatedOutput === "string") tracked.aggregatedOutput = item.aggregatedOutput;
        if (typeof item.durationMs === "number") tracked.durationMs = item.durationMs;
        if (tracked.status === "running") tracked.status = "completed";
        if (!tracked.detached) {
          // Never earned membership: an ordinary command that finished inside
          // its turn. It is transcript history, not background work, so drop it
          // rather than letting the registry grow one entry per command.
          this.backgroundProcessesFor(session.threadId).delete(itemId);
        } else {
          this.emitBackgroundProcesses(session.id);
          processExited = true;
          // Attention belongs to work that outlived its turn, never to a
          // command's exit code. Only detached processes reach here, so this is
          // the detached resource the user walked away from stopping. The server
          // owns the decision so it holds regardless of which workspace the user
          // is viewing (see CodexAttentionHub).
          //
          // A command that finished inside its turn is a *result* — `grep`
          // finding nothing, a failing test run — which the agent already saw
          // and will report. It never reaches here, because it never earned
          // membership.
          if (wasRunning && isFailedBackgroundProcess(tracked)) {
            this.emit({
              type: "backgroundProcess.failed",
              sessionId: session.id,
              threadId: session.threadId,
              workspaceId: session.workspaceId,
              sessionTitle: session.title,
              itemId: tracked.itemId,
              processId: tracked.processId,
              command: tracked.command,
              ...(typeof tracked.exitCode === "number" ? { exitCode: tracked.exitCode } : {}),
            });
          }
        }
      }
    }
    this.emit({ type: "item.completed", sessionId: session.id, threadId: threadId ?? "", itemType, item: item ?? null, turnId: typeof turnId === "string" ? turnId : "" });
    // An exit mid-turn must not drop the subscription a live turn still needs.
    if (processExited && session.status !== "running") this.maybeReleaseThread(session.threadId);
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
   * Prefer the engine's name/title/preview after the first turn, then derive a
   * readable title from the first user request if metadata is missing. Persist
   * it as a thread name and guard against a manual rename during the read.
   */
  private async adoptGeneratedTitle(session: CodexSession, threadId: string): Promise<void> {
    const engine = this.engine;
    const current = session.title.trim();
    if (!engine || (current && !isPendingTaskTitle(current))) return;
    try {
      const raw = await engine.readThread(threadId) as { thread?: { name?: unknown; title?: unknown; preview?: unknown } };
      const generated = threadDisplayTitle(raw.thread ?? {}) || threadTitleFromEngineText(this.pendingTitleInputs.get(session.id));
      if (!generated || generated === current || this.sessions.get(session.id) !== session || !isPendingTaskTitle(session.title)) return;
      if (!selectCodexThreadName({ name: raw.thread?.name })) await engine.renameThread(threadId, generated);
      if (this.sessions.get(session.id) !== session || !isPendingTaskTitle(session.title)) return;
      this.pendingTitleInputs.delete(session.id);
      this.namedThreads.add(threadId);
      session.title = generated;
      this.emit({ type: "session.updated", session: { ...session } });
    } catch {
      // Best-effort: the placeholder stays until the next read instead.
    }
  }

  /**
   * Finalizing a turn reads a git baseline per repository root, so it is
   * deliberately off the completion path: the session must settle to idle
   * before any of that I/O, or a prompt/steer reply that races the engine's
   * completion still observes a running turn. Best-effort like the title
   * adoption — the changes card simply stays absent.
   */
  private async finalizeTurnChanges(session: CodexSession, turnId: string): Promise<void> {
    try {
      const changes = await this.turnChanges.finalizeTurn(session.id, turnId);
      this.emit({ type: "turn.changes", sessionId: session.id, changes });
    } catch {
      // The turn itself is done; unreadable baselines are not a turn failure.
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
    const completedTurnId = turn?.id ?? session.turnId;
    session.status = turn?.status === "failed" || turn?.error || error ? "error" : "idle";
    session.turnId = null;
    this.emit({ type: "session.updated", session: { ...session } });
    this.emit({ type: "turn.completed", sessionId: session.id, threadId: tid, outcome: session.status === "error" ? "failed" : turn?.status === "completed" ? "completed" : "cancelled" });
    // Membership is decided here: a command still running when its turn ends
    // has outlived the turn and becomes background work; everything else from
    // that turn settled and is dropped. The item stream alone cannot tell the
    // two apart, which is why a `grep` that exited 1 used to raise attention.
    const processes = this.backgroundProcessesFor(tid);
    let detachedChanged = false;
    for (const [itemId, process] of processes) {
      if (process.detached) continue;
      const fromCompletedTurn = !process.turnId || !completedTurnId || process.turnId === completedTurnId;
      if (fromCompletedTurn && process.status === "running") {
        process.detached = true;
        detachedChanged = true;
      } else {
        processes.delete(itemId);
      }
    }
    if (detachedChanged) this.emitBackgroundProcesses(session.id);
    // Idle now — but only let the engine unload the thread (and drop its
    // writer lock) if no background process still owns it. A dev server left
    // running is live work, not a leak of the writer lock.
    this.maybeReleaseThread(tid);
    void this.adoptGeneratedTitle(session, tid);
    if (completedTurnId) void this.finalizeTurnChanges(session, completedTurnId);
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

  listQuestions(): CodexQuestion[] {
    return [...this.pendingQuestions.values()].map(entry => entry.question);
  }

  respondQuestion(requestId: string, answers: string[][]): void {
    const pending = this.pendingQuestions.get(requestId);
    if (!pending || !this.engine) throw new Error("Question is no longer pending");
    if (answers.length !== pending.question.questions.length) throw new Error("Answer every question");
    const response = Object.fromEntries(pending.question.questions.map((q, index) => [q.id, { answers: answers[index] }]));
    this.engine.respond(pending.requestId, { answers: response });
    this.pendingQuestions.delete(requestId);
    this.emit({ type: "question.replied", sessionId: pending.question.sessionID, properties: { sessionID: pending.question.sessionID, requestID: requestId } });
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
