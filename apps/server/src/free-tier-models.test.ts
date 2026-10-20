// Tests for free-tier model reconciliation.
//
// Regression these pin: the upstream catalog is the truth for *existence*, the
// cloud allowlist is the truth for *permission* (retention policy differs per
// model, so a newly published free model must not appear in the picker on its
// own), and a model this machine just saw 429 must stop being advertised
// without waiting for a deploy.
import { describe, expect, it } from "bun:test";

import { BUNDLED_FREE_TIER_CONFIG, type FreeTierConfig } from "./free-tier-config.js";
import { createFreeTierModelRegistry } from "./free-tier-models.js";

const UPSTREAM = "https://opencode.ai/inference/v1/models";

function catalog(ids: string[]): Response {
  return new Response(JSON.stringify({ object: "list", data: ids.map((id) => ({ id, object: "model" })) }), {
    headers: { "content-type": "application/json" },
  });
}

function withDiscovery(overrides: Partial<NonNullable<FreeTierConfig["discovery"]>>): FreeTierConfig {
  return {
    ...BUNDLED_FREE_TIER_CONFIG,
    discovery: {
      mode: "intersect",
      modelsUrl: UPSTREAM,
      ttlSeconds: 900,
      freeIdPattern: "-free$",
      extraFreeIds: ["big-pickle"],
      ...overrides,
    },
  };
}

describe("intersect mode (default)", () => {
  it("drops allowlist models the upstream no longer offers", async () => {
    const registry = createFreeTierModelRegistry({
      config: withDiscovery({}),
      fetcher: async () => catalog(["deepseek-v4.1-flash-free", "big-pickle"]),
    });

    const list = await registry.list();

    expect(list.models.map((model) => model.id)).toEqual(["deepseek-v4.1-flash-free", "big-pickle"]);
    expect(list.withdrawn.sort()).toEqual(["glm-5.3-flash-free", "minimax-m3.1-flash-free"]);
    expect(list.source).toBe("upstream");
  });

  it("keeps allowlist metadata for models that survive", async () => {
    const registry = createFreeTierModelRegistry({
      config: {
        ...withDiscovery({}),
        models: [{ id: "deepseek-v4.1-flash-free", name: "DeepSeek", contextWindow: 128_000 }],
      },
      fetcher: async () => catalog(["deepseek-v4.1-flash-free"]),
    });

    const list = await registry.list();

    expect(list.models).toEqual([{ id: "deepseek-v4.1-flash-free", name: "DeepSeek", contextWindow: 128_000 }]);
  });

  it("never adds a model that is upstream but not in the allowlist", async () => {
    const registry = createFreeTierModelRegistry({
      config: withDiscovery({}),
      fetcher: async () => catalog(["deepseek-v4.1-flash-free", "brand-new-free", "big-pickle"]),
    });

    const list = await registry.list();

    expect(list.models.map((model) => model.id)).not.toContain("brand-new-free");
  });
});

describe("replace mode", () => {
  it("advertises upstream free-looking models and allowlist metadata where known", async () => {
    const registry = createFreeTierModelRegistry({
      config: withDiscovery({ mode: "replace" }),
      fetcher: async () => catalog(["brand-new-free", "big-pickle", "gpt-6-sol", "test"]),
    });

    const list = await registry.list();

    const ids = list.models.map((model) => model.id);
    expect(ids).toContain("brand-new-free");
    expect(ids).toContain("big-pickle");
    expect(ids).not.toContain("gpt-6-sol");
    expect(ids).not.toContain("test");
    expect(list.models.find((model) => model.id === "big-pickle")?.name).toBe("Big Pickle");
  });
});

describe("off mode", () => {
  it("does not call the upstream catalog at all", async () => {
    let calls = 0;
    const registry = createFreeTierModelRegistry({
      config: withDiscovery({ mode: "off" }),
      fetcher: async () => {
        calls += 1;
        return catalog([]);
      },
    });

    expect((await registry.list()).models).toHaveLength(BUNDLED_FREE_TIER_CONFIG.models.length);
    expect(calls).toBe(0);
  });
});

describe("degradation", () => {
  it("serves the allowlist when the catalog is unreachable", async () => {
    const registry = createFreeTierModelRegistry({
      config: withDiscovery({}),
      fetcher: async () => {
        throw new Error("offline");
      },
    });

    const list = await registry.list();

    expect(list.models.map((model) => model.id)).toEqual(
      BUNDLED_FREE_TIER_CONFIG.models.map((model) => model.id),
    );
    expect(list.source).toBe("allowlist");
    expect(list.error).toContain("offline");
  });

  it("caches the catalog until its ttl expires", async () => {
    let calls = 0;
    let now = 1_000;
    const registry = createFreeTierModelRegistry({
      config: withDiscovery({ ttlSeconds: 60 }),
      now: () => now,
      fetcher: async () => {
        calls += 1;
        return catalog(["big-pickle"]);
      },
    });

    await registry.list();
    await registry.list();
    expect(calls).toBe(1);

    now += 61_000;
    await registry.list();
    expect(calls).toBe(2);
  });

  it("hides a model that just refused work, then restores it", async () => {
    let now = 1_000;
    const registry = createFreeTierModelRegistry({
      config: withDiscovery({}),
      now: () => now,
      fetcher: async () =>
        catalog(["deepseek-v4.1-flash-free", "glm-5.3-flash-free", "big-pickle"]),
    });

    registry.markUnavailable("glm-5.3-flash-free");

    expect((await registry.list()).models.map((model) => model.id)).not.toContain("glm-5.3-flash-free");

    now += 6 * 60_000;
    expect((await registry.list()).models.map((model) => model.id)).toContain("glm-5.3-flash-free");
  });
});
