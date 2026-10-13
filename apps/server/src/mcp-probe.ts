/**
 * Active MCP handshake probe.
 *
 * A configured MCP entry is not proof that the thing speaks MCP. A command that
 * starts, prints a banner, and exits — a package installer, a one-shot CLI —
 * registers cleanly and then exposes zero tools. The engine reports that as
 * "connected" because a threadless inventory has no runtime status to read.
 *
 * This probe actually performs the handshake (`initialize` -> `tools/list`) so
 * the add flow can refuse an entry that cannot serve tools, instead of writing
 * config that silently does nothing.
 */
import { spawn } from "node:child_process";

import { externalFetch } from "./server-fetch.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const PROTOCOL_VERSION = "2024-11-05";

export type McpProbeTransport = "http" | "stdio";
export type McpProbeStage = "spawn" | "initialize" | "tools/list";

export type McpProbeTool = { name: string; description?: string };

export type McpProbeResult =
  | { ok: true; transport: McpProbeTransport; tools: McpProbeTool[]; durationMs: number }
  | { ok: false; transport: McpProbeTransport; stage: McpProbeStage; error: string; durationMs: number };

export type McpProbeInput = {
  url?: string;
  headers?: Record<string, string>;
  command?: string[];
  env?: Record<string, string>;
  timeoutMs?: number;
};

type JsonRpcMessage = {
  id?: number | string | null;
  method?: string;
  result?: unknown;
  error?: { message?: string };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTools(result: unknown): McpProbeTool[] | null {
  if (!isRecord(result) || !Array.isArray(result.tools)) return null;
  return result.tools.flatMap((tool) => {
    if (!isRecord(tool) || typeof tool.name !== "string" || tool.name.length === 0) return [];
    return [{ name: tool.name, ...(typeof tool.description === "string" ? { description: tool.description } : {}) }];
  });
}

function initializeParams() {
  return {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "sofia", version: "1.0.0" },
  };
}

/** Streamable HTTP may answer with plain JSON or an SSE frame carrying the JSON-RPC payload. */
function parseHttpBody(body: string): JsonRpcMessage | null {
  const trimmed = body.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return isRecord(parsed) ? (parsed as JsonRpcMessage) : null;
    } catch {
      return null;
    }
  }
  for (const line of trimmed.split(/\r?\n/)) {
    const payload = line.startsWith("data:") ? line.slice("data:".length).trim() : "";
    if (!payload || payload === "[DONE]") continue;
    try {
      const parsed: unknown = JSON.parse(payload);
      if (isRecord(parsed) && (parsed.result !== undefined || parsed.error !== undefined)) {
        return parsed as JsonRpcMessage;
      }
    } catch {
      // Not a JSON-RPC frame; keep scanning.
    }
  }
  return null;
}

export async function probeMcpServer(input: McpProbeInput): Promise<McpProbeResult> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;
  const command = (input.command ?? []).map((token) => token.trim()).filter(Boolean);

  if (input.url && command.length === 0) {
    return await probeHttp(input.url, input.headers ?? {}, timeoutMs, startedAt, elapsed);
  }
  if (command.length > 0) {
    return await probeStdio(command, input.env ?? {}, timeoutMs, startedAt, elapsed);
  }
  return { ok: false, transport: "stdio", stage: "spawn", error: "No MCP URL or command was provided.", durationMs: elapsed() };
}

async function probeHttp(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  startedAt: number,
  elapsed: () => number,
): Promise<McpProbeResult> {
  const sessionHeaders: Record<string, string> = {};
  let stage: McpProbeStage = "initialize";

  const send = async (payload: Record<string, unknown>): Promise<JsonRpcMessage | null> => {
    const controller = new AbortController();
    const remaining = Math.max(1_000, timeoutMs - (Date.now() - startedAt));
    const timer = setTimeout(() => controller.abort(), remaining);
    try {
      const response = await externalFetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...headers,
          ...sessionHeaders,
        },
        body: JSON.stringify({ jsonrpc: "2.0", ...payload }),
        signal: controller.signal,
      });
      const sessionId = response.headers.get("mcp-session-id");
      if (sessionId) sessionHeaders["mcp-session-id"] = sessionId;
      if (!response.ok) return null;
      return parseHttpBody(await response.text());
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  const initialize = await send({ id: 1, method: "initialize", params: initializeParams() });
  if (!initialize || initialize.error || !initialize.result) {
    return {
      ok: false,
      transport: "http",
      stage,
      error: initialize?.error?.message ?? "The endpoint did not complete an MCP initialize handshake.",
      durationMs: elapsed(),
    };
  }

  await send({ method: "notifications/initialized", params: {} });

  stage = "tools/list";
  const listed = await send({ id: 2, method: "tools/list", params: {} });
  if (!listed || listed.error) {
    return {
      ok: false,
      transport: "http",
      stage,
      error: listed?.error?.message ?? "The endpoint did not answer tools/list.",
      durationMs: elapsed(),
    };
  }

  const tools = parseTools(listed.result);
  if (!tools) {
    return { ok: false, transport: "http", stage, error: "The tools/list response did not include a tools array.", durationMs: elapsed() };
  }
  return { ok: true, transport: "http", tools, durationMs: elapsed() };
}

function probeStdio(
  command: string[],
  env: Record<string, string>,
  timeoutMs: number,
  startedAt: number,
  elapsed: () => number,
): Promise<McpProbeResult> {
  return new Promise((resolve) => {
    let settled = false;
    let stage: McpProbeStage = "spawn";
    let stdout = "";
    let stderr = "";

    const finish = (result: McpProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child?.kill("SIGKILL");
      } catch {
        // Already gone.
      }
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({ ok: false, transport: "stdio", stage, error: `Timed out during ${stage} after ${timeoutMs}ms.`, durationMs: elapsed() });
    }, timeoutMs);

    let child: ReturnType<typeof spawn> | undefined;
    try {
      child = spawn(command[0], command.slice(1), {
        env: { ...process.env, ...env },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      finish({
        ok: false,
        transport: "stdio",
        stage: "spawn",
        error: error instanceof Error ? error.message : "Failed to start the MCP command.",
        durationMs: elapsed(),
      });
      return;
    }

    const write = (message: Record<string, unknown>) => {
      try {
        child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
      } catch {
        // The child closed its stdin; the exit handler reports it.
      }
    };

    const handleMessage = (message: JsonRpcMessage) => {
      if (message.id === 1) {
        if (message.error || !message.result) {
          finish({ ok: false, transport: "stdio", stage: "initialize", error: message.error?.message ?? "The command did not complete an MCP initialize handshake.", durationMs: elapsed() });
          return;
        }
        write({ method: "notifications/initialized", params: {} });
        write({ id: 2, method: "tools/list", params: {} });
        return;
      }
      if (message.id === 2) {
        if (message.error) {
          finish({ ok: false, transport: "stdio", stage: "tools/list", error: message.error.message ?? "tools/list failed.", durationMs: elapsed() });
          return;
        }
        const tools = parseTools(message.result);
        if (!tools) {
          finish({ ok: false, transport: "stdio", stage: "tools/list", error: "The tools/list response did not include a tools array.", durationMs: elapsed() });
          return;
        }
        finish({ ok: true, transport: "stdio", tools, durationMs: elapsed() });
      }
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      const lines = stdout.split(/\r?\n/);
      stdout = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{")) continue;
        try {
          const parsed: unknown = JSON.parse(trimmed);
          if (isRecord(parsed)) handleMessage(parsed as JsonRpcMessage);
        } catch {
          // Non-JSON output on stdout is exactly the failure this probe detects.
        }
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-2_000);
    });

    child.on("error", (error) => {
      finish({ ok: false, transport: "stdio", stage, error: error.message, durationMs: elapsed() });
    });

    child.on("exit", (code) => {
      finish({
        ok: false,
        transport: "stdio",
        stage,
        error: `The command exited with code ${code ?? "null"} before completing the MCP handshake${stderr.trim() ? `: ${stderr.trim().split(/\r?\n/).slice(-3).join(" ")}` : "."}`,
        durationMs: elapsed(),
      });
    });

    stage = "initialize";
    child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: initializeParams() })}\n`);
  });
}
