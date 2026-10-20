// Tests for the free-tier provider contract and its loopback gateway.
//
// Regression these pin: the upstream rejects a request unless the client
// presents a specific fingerprint (UA shape, session-id shape, streamed body,
// and `bash` + `read` in the tool list). That fingerprint is expected to change
// without notice, so it must come from the remote document — never from a
// literal in the request path — and a bad document must never replace the last
// good one.
import { afterEach, describe, expect, it } from "bun:test";

import {
  BUNDLED_FREE_TIER_CONFIG,
  buildFreeTierHeaders,
  clearFreeTierConfigCache,
  createFreeTierSessionId,
  freeTierConfigSchema,
  freeTierModelList,
  loadFreeTierConfig,
} from "./free-tier-config.js";
import {
  freeTierEndpoint,
  isLoopbackRequest,
  prepareFreeTierChatBody,
  proxyFreeTierChat,
} from "./free-tier-gateway.js";

type Call = { url: string; init?: RequestInit };

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

function recordingFetcher(response: Response, calls: Call[]) {
  return async (input: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url: input, init });
    return response;
  };
}

afterEach(() => {
  clearFreeTierConfigCache();
});

describe("bundled contract", () => {
  it("is a valid document on its own", () => {
    expect(freeTierConfigSchema.safeParse(BUNDLED_FREE_TIER_CONFIG).success).toBe(true);
  });

  it("carries both tools the upstream requires", () => {
    const names = BUNDLED_FREE_TIER_CONFIG.requiredTools.map((tool) => tool.name);
    expect(names).toContain("bash");
    expect(names).toContain("read");
  });
});

describe("session id", () => {
  it("matches the upstream shape: prefix + hex time + base62 suffix", () => {
    const id = createFreeTierSessionId(BUNDLED_FREE_TIER_CONFIG, 1_792_484_598_000);
    expect(id).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  });

  it("follows the remote document rather than a literal", () => {
    const config = {
      ...BUNDLED_FREE_TIER_CONFIG,
      identity: {
        ...BUNDLED_FREE_TIER_CONFIG.identity,
        session: { prefix: "sess_", timeHexLength: 8, randomBase62Length: 20 },
      },
    };
    expect(createFreeTierSessionId(config)).toMatch(/^sess_[0-9a-f]{8}[0-9A-Za-z]{20}$/);
  });
});

describe("outbound fingerprint", () => {
  it("derives the user agent from the template and version", () => {
    const headers = buildFreeTierHeaders(BUNDLED_FREE_TIER_CONFIG, "ses_abc");
    expect(headers["user-agent"]).toBe(`opencode/${BUNDLED_FREE_TIER_CONFIG.identity.version}`);
    expect(headers["x-opencode-session"]).toBe("ses_abc");
    expect(headers["x-opencode-client"]).toBe(BUNDLED_FREE_TIER_CONFIG.identity.clientName);
  });

  it("omits authorization when the document does not set one", () => {
    const config = {
      ...BUNDLED_FREE_TIER_CONFIG,
      identity: { ...BUNDLED_FREE_TIER_CONFIG.identity, authorization: undefined },
    };
    expect(buildFreeTierHeaders(config, "ses_abc").authorization).toBeUndefined();
  });
});

describe("chat body preparation", () => {
  it("forces streaming", () => {
    const prepared = prepareFreeTierChatBody(BUNDLED_FREE_TIER_CONFIG, {
      messages: [{ role: "user", content: "hi" }],
      stream: false,
    });
    expect(prepared.body.stream).toBe(true);
  });

  it("injects both required tools when the caller sends none", () => {
    const prepared = prepareFreeTierChatBody(BUNDLED_FREE_TIER_CONFIG, {
      messages: [{ role: "user", content: "hi" }],
    });
    expect(prepared.injectedTools.sort()).toEqual(["bash", "read"]);
    const tools = prepared.body.tools as Array<{ function: { name: string } }>;
    expect(tools.map((tool) => tool.function.name).sort()).toEqual(["bash", "read"]);
  });

  it("keeps a caller-supplied tool and only adds the missing one", () => {
    const prepared = prepareFreeTierChatBody(BUNDLED_FREE_TIER_CONFIG, {
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "bash", description: "mine", parameters: {} } }],
    });
    expect(prepared.injectedTools).toEqual(["read"]);
    const tools = prepared.body.tools as Array<{ function: { name: string; description: string } }>;
    const bash = tools.find((tool) => tool.function.name === "bash");
    expect(bash?.function.description).toBe("mine");
    expect(tools).toHaveLength(2);
  });
});

describe("proxy", () => {
  it("posts the prepared body to the configured endpoint", async () => {
    const calls: Call[] = [];
    const upstream = new Response("data: [DONE]\n\n", {
      headers: { "content-type": "text/event-stream" },
    });
    const response = await proxyFreeTierChat(
      {
        config: BUNDLED_FREE_TIER_CONFIG,
        sessionId: "ses_abc",
        fetcher: recordingFetcher(upstream, calls),
      },
      { messages: [{ role: "user", content: "hi" }] },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://opencode.ai/inference/openai/v1/chat/completions");
    const sent = JSON.parse(String(calls[0].init?.body)) as { stream: boolean; tools: unknown[] };
    expect(sent.stream).toBe(true);
    expect(sent.tools).toHaveLength(2);
  });

  it("turns a fingerprint rejection into an actionable app error", async () => {
    const response = await proxyFreeTierChat(
      {
        config: BUNDLED_FREE_TIER_CONFIG,
        sessionId: "ses_abc",
        fetcher: async () =>
          jsonResponse({ type: "error", error: { type: "FreeTierError", message: "nope" } }, { status: 403 }),
      },
      { messages: [{ role: "user", content: "hi" }] },
    );

    expect(response.status).toBe(502);
    const payload = await response.json() as { error: { code: string } };
    expect(payload.error.code).toBe("free_tier_fingerprint_rejected");
  });

  it("rejects a body with no messages before any egress", async () => {
    let called = false;
    const response = await proxyFreeTierChat(
      {
        config: BUNDLED_FREE_TIER_CONFIG,
        sessionId: "ses_abc",
        fetcher: async () => {
          called = true;
          return new Response("");
        },
      },
      { messages: [] },
    );
    expect(response.status).toBe(400);
    expect(called).toBe(false);
  });
});

describe("model listing", () => {
  it("serves the remote model list in OpenAI shape", () => {
    const list = freeTierModelList(BUNDLED_FREE_TIER_CONFIG);
    expect(list.object).toBe("list");
    expect(list.data.map((model) => model.id)).toContain("deepseek-v4.1-flash-free");
    expect(list.data.every((model) => model.owned_by === "sofia-free")).toBe(true);
  });

  it("joins the configured base and path without doubling slashes", () => {
    const config = {
      ...BUNDLED_FREE_TIER_CONFIG,
      upstream: { ...BUNDLED_FREE_TIER_CONFIG.upstream, baseUrl: "https://example.test/v1/" },
    };
    expect(freeTierEndpoint(config, "chat")).toBe("https://example.test/v1/chat/completions");
  });
});

describe("remote config resolution", () => {
  it("prefers the remote document", async () => {
    const remote = {
      ...BUNDLED_FREE_TIER_CONFIG,
      version: 7,
      models: [{ id: "future-free", name: "Future Free" }],
    };
    const resolved = await loadFreeTierConfig({
      url: "https://cloud.test/free-tier.json",
      fetcher: async () => jsonResponse(remote, { headers: { etag: "v7" } }),
    });

    expect(resolved.source).toBe("remote");
    expect(resolved.config.version).toBe(7);
    expect(resolved.config.models[0].id).toBe("future-free");
  });

  it("falls back to the bundle when the document is invalid", async () => {
    const resolved = await loadFreeTierConfig({
      url: "https://cloud.test/free-tier.json",
      fetcher: async () => jsonResponse({ version: 2, enabled: true }),
    });

    expect(resolved.source).toBe("bundled");
    expect(resolved.config.version).toBe(BUNDLED_FREE_TIER_CONFIG.version);
    expect(resolved.error).toContain("invalid");
  });

  it("falls back to the bundle when the fetch throws", async () => {
    const resolved = await loadFreeTierConfig({
      url: "https://cloud.test/free-tier.json",
      fetcher: async () => {
        throw new Error("offline");
      },
    });

    expect(resolved.source).toBe("bundled");
    expect(resolved.error).toContain("offline");
  });

  it("serves the last good document when a refresh fails", async () => {
    const calls: Call[] = [];
    const remote = { ...BUNDLED_FREE_TIER_CONFIG, version: 9 };
    const good = recordingFetcher(jsonResponse(remote), calls);
    await loadFreeTierConfig({ url: "https://cloud.test/free-tier.json", fetcher: good });

    const resolved = await loadFreeTierConfig({
      url: "https://cloud.test/free-tier.json",
      // TTL has elapsed, so the stale entry is revalidated and then used.
      now: () => Date.now() + 10 * 60_000,
      fetcher: async () => {
        throw new Error("cloud down");
      },
    });

    expect(resolved.source).toBe("cached");
    expect(resolved.config.version).toBe(9);
    expect(resolved.error).toContain("cloud down");
  });

  it("uses the bundle when no URL is configured", async () => {
    const resolved = await loadFreeTierConfig({});
    expect(resolved.source).toBe("bundled");
  });
});

describe("loopback guard", () => {
  it("accepts a localhost host header", () => {
    const request = new Request("http://127.0.0.1:8787/free-tier/v1/models", {
      headers: { host: "127.0.0.1:8787" },
    });
    expect(isLoopbackRequest(request)).toBe(true);
  });

  it("rejects a forwarded request", () => {
    const request = new Request("http://127.0.0.1:8787/free-tier/v1/models", {
      headers: { host: "127.0.0.1:8787", "x-forwarded-for": "10.0.0.1" },
    });
    expect(isLoopbackRequest(request)).toBe(false);
  });

  it("rejects a non-loopback host", () => {
    const request = new Request("http://example.test/free-tier/v1/models", {
      headers: { host: "example.test" },
    });
    expect(isLoopbackRequest(request)).toBe(false);
  });
});
