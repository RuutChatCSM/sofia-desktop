import { expect } from "vitest";
import { test } from "@sofia/testkit";
import { buildCodexModelCatalog, mergeCodexCatalogModels } from "../../apps/server/src/codex-model-catalog";

test("connected models retain their limits while runtime metadata fills a smaller model's missing cap", () => {
  const models = mergeCodexCatalogModels([
    { id: "large", name: "Connected large", contextWindow: 1_000_000 },
    { id: "small", name: "Connected small", contextWindow: null },
  ], [
    { id: "large", name: "Runtime large", contextWindow: 500_000 },
    { id: "small", name: "Runtime small", contextWindow: 200_000 },
    { id: "additional", name: "Additional", contextWindow: 128_000 },
  ]);
  expect(models).toEqual([
    { id: "large", name: "Connected large", contextWindow: 1_000_000 },
    { id: "small", name: "Connected small", contextWindow: 200_000 },
    { id: "additional", name: "Additional", contextWindow: 128_000 },
  ]);
  expect(buildCodexModelCatalog(models).models.map(model => ({
    slug: model.slug, context: model.context_window, maximum: model.max_context_window,
  }))).toEqual([
    { slug: "large", context: 1_000_000, maximum: 1_000_000 },
    { slug: "small", context: 200_000, maximum: 200_000 },
    { slug: "additional", context: 128_000, maximum: 128_000 },
  ]);
});

test("unknown aliases stay unknown rather than borrowing another model's context", () => {
  expect(mergeCodexCatalogModels([{ id: "alias", name: "Alias" }], [
    { id: "documented", name: "Documented", contextWindow: 200_000 },
  ])).toEqual([
    { id: "alias", name: "Alias" },
    { id: "documented", name: "Documented", contextWindow: 200_000 },
  ]);
});
