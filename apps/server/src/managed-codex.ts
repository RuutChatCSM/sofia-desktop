// Managed Codex engine: spawns `Sofia app-server --listen stdio://` and speaks
// its JSON-RPC 2.0 protocol (newline-delimited JSON over stdio). This is the
// embedding surface the ChatGPT/Codex desktop app uses, so Sofia App can drive a
// real Codex runtime side-by-side with the Sofia engine.
//
// Protocol (from openai/Sofia app-server-transport + app-server-protocol):
//   - Transport: newline-delimited JSON-RPC 2.0 over stdin/stdout.
//   - Handshake: LSP-style `initialize` request with `clientInfo`.
//   - Requests:   `thread/start`, `turn/start`, `turn/read`, etc.
//   - Notifications (server -> client): `thread/started`, `turn/started`,
//     `item/started`, `item/agentMessage/delta`, `item/completed`,
//     `item/commandExecution/requestApproval`, `turn/completed`, etc.
//
// Reliability (matching the ChatGPT/Codex desktop app):
//   - version probe (`--version`) + minimum-version gate before connect
//   - automatic reconnect with exponential backoff when the child exits
//   - per-request timeouts so a hung server never blocks the caller
//   - response correlation by id; server->client requests surface as events
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface, type Interface } from "node:readline";

import {
  extractVersionFromOutput,
  hasCodexFeature,
  type CodexFeature,
} from "./codex-version.js";

export type CodexEngineOptions = {
  bin: string;
  cwd: string;
  codexHome?: string;
  env?: Record<string, string>;
  debug?: boolean;
  /** Interpreter to run `bin` with (e.g. process.execPath for test scripts). */
  interpreter?: string;
  /** Reconnect after unexpected exit, with exponential backoff. Default false. */
  retry?: boolean;
  /** First retry delay (ms). Doubles each attempt, up to maxRetryDelayMs. */
  retryBaseDelayMs?: number;
  maxRetryDelayMs?: number;
  /** Per-request timeout in ms. Default 60s. */
  requestTimeoutMs?: number;
};

export type CodexEngineState = {
  threadId: string;
  turnId: string | null;
};

export type CodexEngineInfo = {
  running: boolean;
  pid: number | null;
  cwd: string;
  userAgent: string | null;
  codexHome: string | null;
  version: string | null;
};

const DEBUG_TAG = "[sofia-engine]";

const DEFAULT_RETRY_BASE_MS = 250;
const DEFAULT_MAX_RETRY_MS = 4000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

function buildEnv(options: CodexEngineOptions): Record<string, string> {
  const base = { ...(options.env ?? {}) };
  if (options.codexHome) {
    // Released Sofia uses SOFIA_HOME; older bundled engines use CODEX_HOME.
    // Both must read the same config, credentials and session store.
    base.SOFIA_HOME = options.codexHome;
    base.CODEX_HOME = options.codexHome;
  }
  // The engine resolves provider API keys from its scratch homes
  // (`~/.sofia`, `~/.config/sofia`) relative to $HOME. Keep HOME exported so
  // that fallback (and the `~/.codex` import) works — without it the only key
  // file the engine can read is `$CODEX_HOME/sofia-auth.json`.
  if (!base.HOME && process.env.HOME) base.HOME = process.env.HOME;
  if (!base.USERPROFILE && process.env.USERPROFILE) base.USERPROFILE = process.env.USERPROFILE;
  // A bare engine command (e.g. SOFIA_CODEX_BIN=sofia in headless
  // deployments) is resolved through PATH, but child processes do not inherit
  // the parent environment automatically. Pass PATH through so spawn succeeds.
  if (!base.PATH && process.env.PATH) base.PATH = process.env.PATH;
  if (!base.PATHEXT && process.env.PATHEXT) base.PATHEXT = process.env.PATHEXT;
  // Force non-interactive app-server mode.
  base.CODEX_EXPERIMENTAL_APP_SERVER = "1";
  return base;
}

/** Probe `codex --version` once so we can gate the binary before connecting. */
export async function probeCodexVersion(options: Pick<CodexEngineOptions, "bin" | "interpreter" | "env">): Promise<string | null> {
  return await new Promise((resolve) => {
    try {
      const args = options.interpreter ? [options.bin, "--version"] : ["--version"];
      const child = spawn(options.interpreter ?? options.bin, args, {
        env: options.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finish = () => {
        if (timer) clearTimeout(timer);
        resolve(extractVersionFromOutput(out) ?? null);
      };
      timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } finish(); }, 5000);
      child.stdout?.on("data", (chunk) => {
        out += String(chunk);
        if (out.length > 4096) finish();
      });
      child.once("error", finish);
      child.once("exit", finish);
    } catch {
      resolve(null);
    }
  });
}

/**
 * Managed Codex engine process with a typed JSON-RPC 2.0 client over stdio.
 * Emits notifications as `(method, params)` events. Automatically reconnects
 * (with backoff) when the child exits unexpectedly, re-runs the initialize
 * handshake, and emits `connected`/`reconnecting` lifecycle events.
 */
export class ManagedCodexEngine {
  private child: ChildProcess | null = null;
  private rl: Interface | null = null;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private nextRequestId = 1;
  private events = new EventEmitter();
  private stderrBuf = "";
  private exited = false;
  private closing = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private initializeResult: { userAgent: string; codexHome: string } | null = null;
  private version: string | null = null;
  private versionChecked = false;

  constructor(private options: CodexEngineOptions) {
    // Version-gate before first spawn so we never run an unsupported binary.
    // Async; failures defer to `initialize()` which awaits the probe.
  }

  /** Subscribe to a notification method, e.g. "item/agentMessage/delta". */
  on(method: string, listener: (params: unknown) => void): this {
    this.events.on(method, listener);
    return this;
  }

  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): this {
    this.events.on("exit", listener);
    return this;
  }

  isAlive(): boolean {
    const child = this.child;
    return !this.exited && !this.closing && child !== null && child.exitCode === null && child.signalCode === null;
  }

  get stderrTail(): string {
    return this.stderrBuf;
  }

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  get info(): CodexEngineInfo {
    return {
      running: this.isAlive(),
      pid: this.pid,
      cwd: this.options.cwd,
      userAgent: this.initializeResult?.userAgent ?? null,
      codexHome: this.initializeResult?.codexHome ?? null,
      version: this.version,
    };
  }

  /** True once the probed binary supports a feature-gated app-server method.
   * Before `initialize()` resolves, the version may not be probed yet and
   * returns false (callers gate on the engine being connected). */
  featureSupported(feature: CodexFeature): boolean {
    return hasCodexFeature(this.version, feature);
  }

  /** Start the child process (spawn + readline + listeners). Internal. */
  private spawnChild(): void {
    const args = this.options.interpreter
      ? [this.options.bin, "app-server", "--listen", "stdio://", "--strict-config"]
      : ["app-server", "--listen", "stdio://", "--strict-config"];
    const child = spawn(this.options.interpreter ?? this.options.bin, args, {
      cwd: this.options.cwd,
      env: buildEnv(this.options),
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.rl = createInterface({ input: child.stdout ?? (undefined as unknown as NodeJS.ReadableStream) });
    this.rl.on("line", (line) => this.handleLine(line));
    child.stderr?.on("data", (chunk) => {
      this.stderrBuf += String(chunk);
      if (this.stderrBuf.length > 8192) this.stderrBuf = this.stderrBuf.slice(-8192);
      if (this.options.debug) console.error(DEBUG_TAG, "stderr:", String(chunk).trim());
    });
    child.on("exit", (code, signal) => this.handleExit(code, signal));
    child.on("error", (error) => {
      this.stderrBuf += `\n${String(error)}`;
      if (this.options.debug) console.error(DEBUG_TAG, "error:", error);
      this.handleExit(null, null);
    });
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.rl?.removeAllListeners();
    this.rl?.close();
    this.rl = null;
    this.child = null;
    // Reject pending requests — they cannot be answered by a dead server.
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error(`Sofia app-server exited (code=${code}, signal=${signal})`));
    }
    this.pending.clear();

    if (this.closing || this.exited) return;

    const willReconnect = this.options.retry !== false && this.versionChecked;
    if (willReconnect) {
      this.events.emit("reconnecting", { code, signal, attempt: this.reconnectAttempt });
      this.scheduleReconnect();
    } else {
      this.exited = true;
      this.events.emit("exit", code, signal);
    }
  }

  private scheduleReconnect(): void {
    if (this.closing) return;
    const delay = Math.min(
      this.options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_MS,
      (this.options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_MS) * 2 ** this.reconnectAttempt,
    );
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.reconnectChild();
    }, delay);
  }

  private async reconnectChild(): Promise<void> {
    if (this.closing) return;
    this.spawnChild();
    try {
      await this.initializeConnection();
      this.reconnectAttempt = 0;
      this.events.emit("connected");
    } catch {
      // The child's exit handler schedules the next attempt. If initialization
      // failed without an exit, terminate this unusable child so that handler
      // owns the retry lifecycle.
      try { this.child?.kill("SIGTERM"); } catch { /* already gone */ }
    }
  }

  private send(message: Record<string, unknown>): void {
    const child = this.child;
    if (!this.isAlive() || !child?.stdin?.writable) {
      throw new Error("Sofia app-server is not running");
    }
    if (this.options.debug) console.log(DEBUG_TAG, "->", JSON.stringify(message));
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line);
    } catch {
      if (this.options.debug) console.error(DEBUG_TAG, "non-JSON line:", line);
      return;
    }
    if (this.options.debug) console.log(DEBUG_TAG, "<-", JSON.stringify(message));
    // Response to a request we sent (id present, no method).
    if (message.id !== undefined && message.method === undefined) {
      if (typeof message.id === "number") {
        const pending = this.pending.get(message.id);
        if (pending) {
          this.pending.delete(message.id);
          clearTimeout(pending.timer);
          if (message.error) pending.reject(new Error(describeRpcError(message.error)));
          else pending.resolve(message.result);
        }
      }
      return;
    }
    // Server -> client request (id + method); must respond.
    if (message.id !== undefined && typeof message.method === "string") {
      this.events.emit("request", message);
      return;
    }
    // Server -> client notification (method only; no id).
    if (typeof message.method === "string") {
      this.events.emit(message.method, message.params ?? {});
      return;
    }
  }

  /** Perform the LSP-style initialize handshake. */
  async initialize(): Promise<{ userAgent: string; codexHome: string }> {
    if (!this.versionChecked) {
      this.versionChecked = true;
      // Probe the version once for diagnostics (`info.version`). There is no
      // enforced minimum here: Sofia App only ever spawns its own bundled Sofia
      // binary (a source build that reports `codex-cli 0.0.0`), so a hard gate
      // would just block the runtime it ships. The version is surfaced for the
      // feature gates and diagnostics, never used to refuse startup.
      const version = await probeCodexVersion(this.options);
      this.version = version;
    }
    if (!this.child) this.spawnChild();
    return await this.initializeConnection();
  }

  private async initializeConnection(): Promise<{ userAgent: string; codexHome: string }> {
    const result = await this.request("initialize", {
      clientInfo: { name: "sofia", version: "1.0.0" },
      capabilities: { experimentalApi: true },
    });
    const response = result as { userAgent?: string; sofiaHome?: string; codexHome?: string };
    const configFile = this.options.env?.SOFIA_APP_CONFIG_FILE;
    if (configFile) {
      const config = await this.request("config/read", { includeLayers: true });
      const layers = config && typeof config === "object" ? Reflect.get(config, "layers") : null;
      const selected = Array.isArray(layers) && layers.some((layer: unknown) => {
        if (!layer || typeof layer !== "object") return false;
        const name = Reflect.get(layer, "name");
        return name && typeof name === "object" && Reflect.get(name, "type") === "user"
          && Reflect.get(name, "file") === configFile;
      });
      if (!selected) {
        await this.close();
        throw new Error("The bundled Sofia engine does not support workspace tool configuration. Update the app and its bundled engine together.");
      }
    }
    this.initializeResult = {
      userAgent: response.userAgent ?? "",
      codexHome: response.sofiaHome ?? response.codexHome ?? "",
    };
    this.reconnectAttempt = 0;
    this.events.emit("connected");
    return this.initializeResult;
  }

  /** Send a JSON-RPC request and await its result. */
  request(method: string, params?: unknown): Promise<unknown> {
    if (!this.isAlive()) {
      return Promise.reject(new Error(`Sofia app-server is not running (${method})`));
    }
    const id = this.nextRequestId++;
    const timeoutMs = this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Sofia RPC request timed out after ${timeoutMs}ms: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const message: Record<string, unknown> = { jsonrpc: "2.0", id, method };
      if (params !== undefined) message.params = params;
      try {
        this.send(message);
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  /** Respond to an inbound server->client JSON-RPC request (approval etc.). */
  respond(id: string | number, result?: unknown, error?: { code: number; message: string }): void {
    if (!this.isAlive()) return;
    const msg: Record<string, unknown> = { id, result };
    if (error) msg.error = error;
    else if (result !== undefined) msg.result = result;
    this.send(msg);
  }

  /** Create a thread (thread/start). */
  async startThread(params: {
    model?: string;
    modelProvider?: string;
    cwd?: string;
    baseInstructions?: string;
    developerInstructions?: string;
    approvalPolicy?: string;
    approvalsReviewer?: "user" | "auto_review";
    ephemeral?: boolean;
    config?: Record<string, unknown>;
  }): Promise<string> {
    const result = await this.request("thread/start", {
      ...params,
      // Paginated history mode so thread/items/list (transcript restore)
      // works — legacy-mode threads reject item listing.
      historyMode: "paginated",
    });
    const payload = result as { threadId?: string; thread?: { id?: string } };
    const threadId = payload.threadId ?? payload.thread?.id;
    if (!threadId) throw new Error("thread/start returned no threadId");
    return threadId;
  }

  /** Start a turn with a user message (turn/start). */
  async startTurn(params: {
    threadId: string;
    input: Array<{ text: string } | { url: string }>;
    cwd?: string;
    model?: string;
    approvalPolicy?: string;
    sandboxPolicy?: { type: string; networkAccess?: boolean };
    approvalsReviewer?: "user" | "auto_review";
  }): Promise<string | null> {
    // The fork's UserInput is a serde-tagged enum: every entry needs a `type`.
    const input = params.input.map((entry) =>
      "text" in entry ? { type: "text", text: entry.text } : { type: "image", url: entry.url },
    );
    const result = await this.request("turn/start", { ...params, input });
    const payload = result as { turnId?: string; turn?: { id?: string } };
    return payload.turnId ?? payload.turn?.id ?? null;
  }

  /** Update sticky thread settings before a later turn (model/provider picker). */
  async updateThreadSettings(params: {
    threadId: string;
    model?: string;
    modelProvider?: string;
  }): Promise<unknown> {
    return await this.request("thread/settings/update", params);
  }

  /** Steer an in-flight turn (turn/steer). */
  async steerTurn(params: { threadId: string; expectedTurnId: string; input: Array<{ text: string } | { url: string }> }): Promise<string | null> {
    const input = params.input.map((entry) =>
      "text" in entry ? { type: "text", text: entry.text } : { type: "image", url: entry.url },
    );
    const result = await this.request("turn/steer", { threadId: params.threadId, expectedTurnId: params.expectedTurnId, input });
    const payload = result as { turnId?: string; turn?: { id?: string } };
    return payload.turnId ?? payload.turn?.id ?? null;
  }

  /** Interrupt the active turn (turn/interrupt). */
  async interruptTurn(threadId: string, turnId: string): Promise<unknown> {
    return await this.request("turn/interrupt", { threadId, turnId });
  }

  /** Read a thread's current state (thread/read). */
  async readThread(threadId: string): Promise<unknown> {
    return await this.request("thread/read", { threadId });
  }

  /** Fork a thread into a new thread (thread/fork). */
  async forkThread(params: { threadId: string; input: Array<{ text: string } | { url: string }> }): Promise<string | null> {
    const input = params.input.map((entry) =>
      "text" in entry ? { type: "text", text: entry.text } : { type: "image", url: entry.url },
    );
    const result = await this.request("thread/fork", { threadId: params.threadId, input });
    const payload = result as { threadId?: string; thread?: { id?: string } };
    return payload.threadId ?? payload.thread?.id ?? null;
  }

  /** Load a persisted thread, optionally from a legacy rollout outside this home. */
  async resumeThread(threadId: string, options?: { path?: string; model?: string; modelProvider?: string }): Promise<unknown> {
    return await this.request("thread/resume", { threadId, ...options });
  }

  /** Archive / unarchive / unsubscribe a thread. */
  async archiveThread(threadId: string, archived = true): Promise<unknown> {
    return await this.request(archived ? "thread/archive" : "thread/unarchive", { threadId });
  }

  async renameThread(threadId: string, name: string): Promise<unknown> {
    return await this.request("thread/name/set", { threadId, name });
  }

  async unsubscribeThread(threadId: string): Promise<unknown> {
    return await this.request("thread/unsubscribe", { threadId });
  }

  /** Permanently delete a persisted thread (thread/delete). */
  async deleteThread(threadId: string): Promise<unknown> {
    return await this.request("thread/delete", { threadId });
  }

  /** List persisted threads so the manager can restore sessions across restarts. */
  async listThreads(params?: {
    limit?: number;
    sourceKinds?: string[];
    archived?: boolean;
  }): Promise<Array<Record<string, unknown>>> {
    const result = await this.request("thread/list", {
      ...(params?.limit ? { limit: params.limit } : {}),
      ...(params?.sourceKinds ? { sourceKinds: params.sourceKinds } : {}),
      ...(params?.archived !== undefined ? { archived: params.archived } : {}),
    });
    const payload = result as { data?: Array<Record<string, unknown>> };
    return payload.data ?? [];
  }

  /** Thread ids currently loaded in the app-server process (writer-lock holders). */
  async listLoadedThreads(): Promise<string[]> {
    const result = await this.request("thread/loaded/list", {});
    const payload = result as { data?: unknown };
    return Array.isArray(payload.data) ? payload.data.filter((id): id is string => typeof id === "string") : [];
  }

  /**
   * List one page of a thread's items (with turn ids). The engine serves pages
   * from the oldest item and returns a `nextCursor`; callers that want the whole
   * transcript must follow it (see CodexSessionManager.getSessionItems).
   */
  async listThreadItems(
    threadId: string,
    params?: { limit?: number; cursor?: string },
  ): Promise<{ items: Array<{ turnId: string; item: Record<string, unknown> }>; nextCursor: string | null }> {
    const result = await this.request("thread/items/list", {
      threadId,
      ...(params?.limit ? { limit: params.limit } : {}),
      ...(params?.cursor ? { cursor: params.cursor } : {}),
    });
    const payload = result as {
      data?: Array<{ turnId?: string; item?: Record<string, unknown> }>;
      nextCursor?: unknown;
    };
    return {
      items: (payload.data ?? []).map((entry) => ({
        turnId: typeof entry.turnId === "string" ? entry.turnId : "",
        item: entry.item ?? {},
      })),
      nextCursor: typeof payload.nextCursor === "string" ? payload.nextCursor : null,
    };
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const child = this.child;
    this.child = null;
    this.exited = true;
    if (!child) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
        resolve();
      }, 1500);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        child.kill("SIGTERM");
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });
  }
}

function describeRpcError(error: unknown): string {
  if (!error || typeof error !== "object") return String(error);
  const e = error as { code?: number | string; message?: string };
  return `Sofia RPC error (${String(e.code ?? "?")}): ${e.message ?? "unknown"}`;
}
