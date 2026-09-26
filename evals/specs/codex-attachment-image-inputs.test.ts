import { expect } from "vitest";
import { test } from "@sofia/testkit";

import { codexPromptFromParts } from "../../apps/app/src/react-app/domains/session/sync/codex-prompt-parts.js";
import { registerCodexRoutes } from "../../apps/server/src/codex-routes.js";
import { matchRoute, type RequestContext, type Route } from "../../apps/server/src/routes/registry.js";
import type { ServerConfig } from "../../apps/server/src/types.js";

const IMAGE_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";

test("a pasted image rides Sofia's turn as an image input, not as base64 prompt text", async ({ evidence }) => {
  const turn = codexPromptFromParts([
    { type: "text", text: "what does this screenshot show?" },
    { type: "file", mime: "image/png", filename: "screenshot.png", url: IMAGE_DATA_URL },
    { type: "file", mime: "application/pdf", filename: "scan.pdf", url: "file:///workspace/.sofia/inbox/scan.pdf" },
  ]);

  expect(turn.images).toEqual([IMAGE_DATA_URL]);
  expect(turn.text).toContain("what does this screenshot show?");
  expect(turn.text).toContain("Referenced file: scan.pdf (file:///workspace/.sofia/inbox/scan.pdf)");
  expect(turn.text).not.toContain("iVBORw0KGgo");
  expect(turn.text).not.toContain("data:image");
  evidence.recordAssertionEvidence(
    "The composed Sofia (codex) turn carries images as structured inputs",
    "The image attachment's data URL is returned in `images` while the prompt text keeps only the user's prose and the workspace path reference — no base64 is inlined into the turn.",
    true,
  );
});

test("the codex prompt and steer routes forward image inputs to the engine", async ({ evidence }) => {
  const calls: Array<{ method: string; text: string; images?: string[] }> = [];
  const session = { id: "codex-t1", threadId: "t1", title: "x", status: "idle" as const, created: "2025-01-01", turnId: null, workspaceId: "w1" };
  const manager = {
    engineInfo: {},
    start: async () => {},
    listSessions: () => [session],
    createSession: async () => session,
    prompt: async (_sessionId: string, text: string, opts?: { images?: string[] }) => {
      calls.push({ method: "prompt", text, images: opts?.images });
      return session;
    },
    steer: async (_sessionId: string, text: string, images?: string[]) => {
      calls.push({ method: "steer", text, images });
      return session;
    },
    abort: async () => {},
    delete: async () => {},
    setArchived: async () => session,
    rename: async () => session,
    getSessionItems: async () => [],
    on: () => () => {},
  };

  const routes: Route[] = [];
  registerCodexRoutes({
    routes,
    config: { host: "127.0.0.1", port: 0, token: "t", workspaces: [] } as unknown as ServerConfig,
    readJsonBody: async (request) => (await request.json()) as Record<string, unknown>,
    requireClientScope: () => {},
    ensureWritable: () => {},
    registry: { getOrCreate: async () => manager },
  });

  const invoke = async (path: string, body: Record<string, unknown>) => {
    const matched = matchRoute(routes, "POST", path);
    if (!matched) throw new Error(`route not registered: ${path}`);
    const request = new Request(`http://127.0.0.1${path}`, { method: "POST", body: JSON.stringify(body) });
    return matched.handler({ request, url: new URL(request.url), params: matched.params } as unknown as RequestContext);
  };

  const sent = await invoke("/workspace/ws_1/codex/sessions/codex-t1/prompt", { text: "look", images: [IMAGE_DATA_URL] });
  expect(sent.status).toBe(200);
  await invoke("/workspace/ws_1/codex/sessions/codex-t1/steer", { text: "and this", images: [IMAGE_DATA_URL] });

  expect(calls).toEqual([
    { method: "prompt", text: "look", images: [IMAGE_DATA_URL] },
    { method: "steer", text: "and this", images: [IMAGE_DATA_URL] },
  ]);
  evidence.recordAssertionEvidence(
    "The Sofia server hands image inputs to the engine on prompt and steer",
    "POST /codex/sessions/:id/prompt and /steer both pass the request's image data URLs through to the session manager, which builds the engine's structured image input.",
    true,
  );
});
