import { recordAudit } from "../audit.js";
import { ApiError } from "../errors.js";
import type { ServerConfig, TokenScope, WorkspaceInfo } from "../types.js";
import { shortId } from "../utils.js";
import { addRoute, type RequestContext, type Route } from "./registry.js";
import { writeCodexAccessMode } from "../codex-access.js";
import { hasRunningCodexSessions } from "../codex-registry.js";

type JsonResponse = (data: unknown, status?: number) => Response;
type ReadJsonBody = (request: Request) => Promise<Record<string, unknown>>;

interface RegisterOperationRoutesOptions {
  routes: Route[];
  config: ServerConfig;
  jsonResponse: JsonResponse;
  readJsonBody: ReadJsonBody;
  requireClientScope: (ctx: RequestContext, required: TokenScope) => void;
  resolveWorkspace: (config: ServerConfig, id: string) => Promise<WorkspaceInfo>;
  reloadOpencodeEngine: (config: ServerConfig, workspace: WorkspaceInfo) => Promise<void>;
}

export function registerOperationRoutes(options: RegisterOperationRoutesOptions): void {
  const {
    routes,
    config,
    jsonResponse,
    readJsonBody,
    requireClientScope,
    resolveWorkspace,
    reloadOpencodeEngine,
  } = options;

  addRoute(routes, "GET", "/workspace/:id/events", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const sinceRaw = ctx.url.searchParams.get("since");
    const since = sinceRaw ? Number(sinceRaw) : undefined;
    const items = ctx.reloadEvents.list(workspace.id, since);
    return jsonResponse({ items, cursor: ctx.reloadEvents.cursor(), workspaceId: workspace.id, disabled: false });
  });

  addRoute(routes, "POST", "/workspace/:id/engine/reload", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    requireClientScope(ctx, "collaborator");

    await reloadOpencodeEngine(config, workspace);

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "engine.reload",
      target: workspace.baseUrl ?? "opencode",
      summary: "Reloaded workspace engine",
      timestamp: Date.now(),
    });

    return jsonResponse({ ok: true, reloadedAt: Date.now() });
  });

  addRoute(routes, "GET", "/approvals", "host", async (ctx) => {
    return jsonResponse({ items: ctx.approvals.list() });
  });

  addRoute(routes, "POST", "/approvals/:id", "host", async (ctx) => {
    const body = await readJsonBody(ctx.request);
    const reply = body.reply === "allow" ? "allow" : "deny";
    const result = ctx.approvals.respond(ctx.params.id, reply);
    if (!result) {
      throw new ApiError(404, "approval_not_found", "Approval request not found");
    }
    return jsonResponse({ ok: true, allowed: result.allowed });
  });

  // ChatGPT-style permission mode: "ask" always prompts, "approve" prompts for
  // unsafe actions, "full" (Full access) never prompts. Mirrors the desktop
  // "How should actions be approved?" selector.
  addRoute(routes, "GET", "/approvals/mode", "host", async (ctx) => {
    return jsonResponse({ mode: ctx.approvals.getMode() });
  });

  addRoute(routes, "PUT", "/approvals/mode", "host", async (ctx) => {
    if (hasRunningCodexSessions(ctx.config)) {
      throw new ApiError(409, "engine_busy", "Stop active Sofia tasks before changing their permissions.");
    }
    const body = await readJsonBody(ctx.request);
    const mode = body.mode;
    if (!["ask", "approve", "full", "manual", "auto"].includes(String(mode))) {
      throw new ApiError(400, "invalid_approval_mode", `invalid approval mode: ${String(mode)}`);
    }
    // Persist the codex access mode (the composer toggle) so the next config
    // generation writes the matching sandbox_mode + MCP approval: one aligned
    // control for "can it write" + "does it ask".
    if (["ask", "approve", "full"].includes(String(mode))) {
      writeCodexAccessMode(String(mode) as "ask" | "approve" | "full");
    }
    ctx.approvals.setMode(String(mode) as "ask" | "approve" | "full" | "manual" | "auto");
    return jsonResponse({ ok: true, mode: ctx.approvals.getMode() });
  });
}
