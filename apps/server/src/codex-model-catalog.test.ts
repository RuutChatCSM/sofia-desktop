// Tests for the model catalog the app hands the engine via `model_catalog_json`.
import { describe, expect, it } from "bun:test";

import {
  buildCodexCatalogModelInfo,
  buildCodexModelCatalog,
  codexCatalogModelsFromProviders,
  codexCatalogModelsFromRuntimeProviderMap,
} from "./codex-model-catalog.js";

describe("buildCodexCatalogModelInfo", () => {
  it("keeps the file-editing tool available for a model the engine has never seen", () => {
    const info = buildCodexCatalogModelInfo({ id: "mimo-v2.5", name: "MiMo v2.5", contextWindow: 1_048_576 });
    // The whole point: without this the engine's fallback withholds apply_patch.
    expect(info.apply_patch_tool_type).toBe("freeform");
    // The engine owns that flag (it sets it when the slug misses the catalog), so
    // the app must never emit it.
    expect(Object.hasOwn(info as unknown as Record<string, unknown>, "used_fallback_model_metadata")).toBe(false);
  });

  it("carries the real context window instead of the engine's 272k fallback", () => {
    const info = buildCodexCatalogModelInfo({ id: "mimo-v2.5", name: "MiMo v2.5", contextWindow: 1_048_576 });
    expect(info.context_window).toBe(1_048_576);
    expect(info.max_context_window).toBe(1_048_576);
    // Omitted so the engine derives the compaction threshold itself.
    expect(info.auto_compact_token_limit).toBeNull();
  });

  it("nulls a missing or nonsense context window rather than inventing one", () => {
    expect(buildCodexCatalogModelInfo({ id: "x", name: "X" }).context_window).toBeNull();
    expect(buildCodexCatalogModelInfo({ id: "x", name: "X", contextWindow: 0 }).context_window).toBeNull();
    expect(buildCodexCatalogModelInfo({ id: "x", name: "X", contextWindow: -5 }).context_window).toBeNull();
  });

  it("emits every field the engine requires, including the null ones", () => {
    const info = buildCodexCatalogModelInfo({ id: "x", name: "X" }) as Record<string, unknown>;
    // Fields with no serde default on the engine side: a missing key fails the
    // whole catalog load at startup.
    for (const key of ["slug", "description", "availability_nux", "upgrade", "default_verbosity", "apply_patch_tool_type"]) {
      expect(Object.hasOwn(info, key)).toBe(true);
    }
    expect(info.shell_type).toBe("unified_exec");
    expect(info.visibility).toBe("list");
    expect(info.truncation_policy).toEqual({ mode: "tokens", limit: 10_000 });
  });
});

describe("buildCodexModelCatalog", () => {
  it("de-duplicates by slug, first entry winning", () => {
    const catalog = buildCodexModelCatalog([
      { id: "dup", name: "First", contextWindow: 1 },
      { id: "dup", name: "Second", contextWindow: 2 },
      { id: "other", name: "Other" },
    ]);
    expect(catalog.models.map((model) => model.slug)).toEqual(["dup", "other"]);
    expect(catalog.models[0]?.display_name).toBe("First");
  });

  it("skips entries with no id", () => {
    expect(buildCodexModelCatalog([{ id: "", name: "nameless" }]).models).toEqual([]);
  });
});

describe("codexCatalogModelsFromProviders", () => {
  it("flattens every provider's models", () => {
    const models = codexCatalogModelsFromProviders([
      { models: [{ id: "a", name: "A" }] },
      { models: [{ id: "b", name: "B", contextWindow: 200_000 }] },
    ]);
    expect(models.map((model) => model.id)).toEqual(["a", "b"]);
  });
});

describe("codexCatalogModelsFromRuntimeProviderMap", () => {
  it("reads models.dev limit.context from the runtime provider shape", () => {
    const models = codexCatalogModelsFromRuntimeProviderMap({
      xiaomi: {
        name: "Xiaomi",
        models: { "mimo-v2.5-pro-ultraspeed": { name: "MiMo", limit: { context: 1_048_576, output: 128_000 } } },
      },
    });
    expect(models).toEqual([{ id: "mimo-v2.5-pro-ultraspeed", name: "MiMo", contextWindow: 1_048_576 }]);
  });

  it("tolerates junk without throwing", () => {
    expect(codexCatalogModelsFromRuntimeProviderMap({ p: { models: "nope" } })).toEqual([]);
    expect(codexCatalogModelsFromRuntimeProviderMap({ p: { models: { m: null } } })).toEqual([
      { id: "m", name: "m", contextWindow: null },
    ]);
  });
});
