// Tests for the models.dev provider catalog.
//
// Regression this pins: the connect modal offered only the 14 providers in the
// engine's env-var discovery list, while the CLI's `/connect` offers the whole
// models.dev catalog (~190 providers with their model lists). Users could not
// connect most providers from the app.
import { afterEach, describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  parseModelsDevCatalog,
  resetModelsDevCatalogCache,
  type CatalogEntry,
} from "./models-dev-catalog.js";

const CATALOG_SNAPSHOT = path.resolve(
  import.meta.dirname,
  "../../../ee/apps/inference/models-site/models/api.json",
);

afterEach(() => {
  resetModelsDevCatalogCache();
});

describe("parseModelsDevCatalog", () => {
  it("keeps a provider with a credential and a base url", () => {
    const [entry] = parseModelsDevCatalog({
      deepseek: {
        id: "deepseek",
        name: "DeepSeek",
        env: ["DEEPSEEK_API_KEY"],
        api: "https://api.deepseek.com/v1",
        models: { "deepseek-chat": { id: "deepseek-chat", name: "DeepSeek Chat" } },
      },
    });
    expect(entry?.id).toBe("deepseek");
    expect(entry?.envKeys).toEqual(["DEEPSEEK_API_KEY"]);
    expect(entry?.baseUrl).toBe("https://api.deepseek.com/v1");
    expect(entry?.models.map((model) => model.id)).toEqual(["deepseek-chat"]);
  });

  it("skips a provider with no credential", () => {
    // Nothing to store means nothing to connect.
    expect(parseModelsDevCatalog({ foo: { name: "Foo", api: "https://x/v1", models: {} } })).toEqual([]);
  });

  it("skips a provider with no base url", () => {
    // The engine has no endpoint to call.
    expect(parseModelsDevCatalog({ foo: { name: "Foo", env: ["FOO_KEY"], models: {} } })).toEqual([]);
  });

  it("keeps every env alias so the engine finds the key", () => {
    const [entry] = parseModelsDevCatalog({
      google: {
        name: "Google",
        env: ["GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "GEMINI_API_KEY"],
        api: "https://generativelanguage.googleapis.com/v1beta",
        models: {},
      },
    });
    // The engine resolves one env_key, so all three names must be writable.
    expect(entry?.envKeys).toEqual([
      "GOOGLE_API_KEY",
      "GOOGLE_GENERATIVE_AI_API_KEY",
      "GEMINI_API_KEY",
    ]);
  });

  it("drops non-chat models from the picker", () => {
    const [entry] = parseModelsDevCatalog({
      xiaomi: {
        name: "Xiaomi",
        env: ["XIAOMI_API_KEY"],
        api: "https://api.xiaomimimo.com/v1",
        models: {
          "mimo-v2.5": { name: "MiMo v2.5" },
          "mimo-v2.5-asr": { name: "MiMo ASR" },
          "mimo-v2.5-tts": { name: "MiMo TTS" },
          "text-embedding-3": { name: "Embedding" },
        },
      },
    });
    expect(entry?.models.map((model) => model.id)).toEqual(["mimo-v2.5"]);
  });

  it("reads reasoning and the context window for compaction sizing", () => {
    const [entry] = parseModelsDevCatalog({
      p: {
        name: "P",
        env: ["P_KEY"],
        api: "https://p/v1",
        models: { m: { name: "M", reasoning: true, limit: { context: 200000 } } },
      },
    });
    expect(entry?.models[0]?.reasoning).toBe(true);
    expect(entry?.models[0]?.contextWindow).toBe(200000);
  });

  it("tolerates a malformed payload", () => {
    expect(parseModelsDevCatalog(null)).toEqual([]);
    expect(parseModelsDevCatalog("nope")).toEqual([]);
    expect(parseModelsDevCatalog({ p: "not-an-object" })).toEqual([]);
  });
});

describe("the shipped models.dev snapshot", () => {
  let catalog: CatalogEntry[];

  it("parses the curated catalog served to clients", async () => {
    catalog = parseModelsDevCatalog(JSON.parse(await readFile(CATALOG_SNAPSHOT, "utf8")));
    // The point of the fix: the app must offer far more than the engine's 14
    // env-discovered providers.
    expect(catalog.length).toBeGreaterThan(100);
  });

  it("includes providers the static well-known list omits", async () => {
    catalog = parseModelsDevCatalog(JSON.parse(await readFile(CATALOG_SNAPSHOT, "utf8")));
    const ids = new Set(catalog.map((entry) => entry.id));
    // OpenRouter-style aggregators and long-tail gateways are only in the
    // catalog, never in the engine's env-var list.
    for (const id of ["openrouter", "deepseek", "qiniu-ai", "neuralwatt"]) {
      expect(ids.has(id)).toBe(true);
    }
  });

  it("gives every entry a credential and a base url", async () => {
    catalog = parseModelsDevCatalog(JSON.parse(await readFile(CATALOG_SNAPSHOT, "utf8")));
    for (const entry of catalog) {
      expect(entry.envKeys.length).toBeGreaterThan(0);
      expect(entry.baseUrl).toBeTruthy();
    }
  });

  it("ships model lists, not just provider names", async () => {
    catalog = parseModelsDevCatalog(JSON.parse(await readFile(CATALOG_SNAPSHOT, "utf8")));
    const withModels = catalog.filter((entry) => entry.models.length > 0);
    expect(withModels.length).toBeGreaterThan(50);
    const deepseek = catalog.find((entry) => entry.id === "deepseek");
    expect(deepseek?.models.length ?? 0).toBeGreaterThan(0);
  });

  it("sorts providers by name for a stable picker order", async () => {
    catalog = parseModelsDevCatalog(JSON.parse(await readFile(CATALOG_SNAPSHOT, "utf8")));
    const names = catalog.map((entry) => entry.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });
});
