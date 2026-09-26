// Tests for the shared connectable provider catalog and the provider auth
// surface derived from it.
//
// Regression this pins: `/provider/auth` used to return a hardcoded object with
// a single `openai` key, so the app's connect modal offered exactly one
// provider no matter what the engine supported. Every non-OpenAI provider was
// unreachable from the app.
import { describe, expect, it } from "bun:test";

import {
  CONNECTABLE_PROVIDERS,
  catalogProvider,
  connectableProviders,
  hasEngineOAuthFlow,
  providerAuthMethodsById,
} from "./provider-catalog.js";

describe("connectable catalog", () => {
  it("offers more than just openai", () => {
    expect(connectableProviders().length).toBeGreaterThan(1);
  });

  it("includes the engine's well-known providers", () => {
    const ids = connectableProviders().map((provider) => provider.id);
    for (const id of [
      "openai",
      "anthropic",
      "openrouter",
      "groq",
      "deepseek",
      "mistral",
      "google",
      "cohere",
      "perplexity",
      "xai",
    ]) {
      expect(ids).toContain(id);
    }
  });

  it("gives every credentialed provider a distinct env key", () => {
    const envKeys = new Set<string>();
    for (const provider of connectableProviders()) {
      expect(provider.envKey).toBeTruthy();
      expect(envKeys.has(provider.envKey as string)).toBe(false);
      envKeys.add(provider.envKey as string);
    }
  });

  it("uses engine-compatible env key names", () => {
    expect(catalogProvider("anthropic")?.envKey).toBe("ANTHROPIC_API_KEY");
    expect(catalogProvider("deepseek")?.envKey).toBe("DEEPSEEK_API_KEY");
    expect(catalogProvider("xai")?.envKey).toBe("XAI_API_KEY");
  });

  it("matches the engine's env var for every well-known provider", () => {
    // Transcribed from the engine's `well_known_providers()`
    // (sofia-rs/model-provider-info/src/lib.rs). A divergence here means a key
    // entered in the app lands in a slot the engine never reads.
    const engineEnvKeys: Record<string, string> = {
      openai: "OPENAI_API_KEY",
      anthropic: "ANTHROPIC_API_KEY",
      openrouter: "OPENROUTER_API_KEY",
      groq: "GROQ_API_KEY",
      together: "TOGETHER_API_KEY",
      deepseek: "DEEPSEEK_API_KEY",
      mistral: "MISTRAL_API_KEY",
      xiaomi: "XIAOMI_API_KEY",
      fireworks: "FIREWORKS_API_KEY",
      cerebras: "CEREBRAS_API_KEY",
      google: "GEMINI_API_KEY",
      cohere: "COHERE_API_KEY",
      perplexity: "PERPLEXITY_API_KEY",
      xai: "XAI_API_KEY",
    };
    for (const [id, envKey] of Object.entries(engineEnvKeys)) {
      expect(catalogProvider(id)?.envKey).toBe(envKey);
    }
  });

  it("keeps the engine's non-derivable env name for google", () => {
    // `google` is the one well-known provider whose env var does not follow
    // `<ID>_API_KEY`. The catalog must carry the engine's name verbatim; the
    // derived fallback alone would write GOOGLE_API_KEY and strand the key.
    expect(catalogProvider("google")?.envKey).toBe("GEMINI_API_KEY");
    expect(catalogProvider("google")?.envKey).not.toBe("GOOGLE_API_KEY");
  });

  it("resolves a provider by id or env key, case-insensitively", () => {
    expect(catalogProvider("Anthropic")?.id).toBe("anthropic");
    expect(catalogProvider("ANTHROPIC_API_KEY")?.id).toBe("anthropic");
    expect(catalogProvider("  openrouter  ")?.id).toBe("openrouter");
    expect(catalogProvider("nope")).toBeNull();
  });

  it("excludes local providers that need no credential", () => {
    const connectable = connectableProviders().map((provider) => provider.id);
    expect(connectable).not.toContain("ollama");
    expect(connectable).not.toContain("lmstudio");
  });
});

describe("providerAuthMethodsById", () => {
  it("returns a non-empty method list for every connectable provider", () => {
    const methods = providerAuthMethodsById();
    for (const provider of connectableProviders()) {
      expect(methods[provider.id]?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("offers an API key for non-OpenAI providers", () => {
    const methods = providerAuthMethodsById();
    expect(methods.anthropic).toEqual([{ type: "api", label: "API key" }]);
    expect(methods.deepseek).toEqual([{ type: "api", label: "API key" }]);
  });

  it("offers oauth only for providers the engine can complete", () => {
    const methods = providerAuthMethodsById();
    expect(methods.openai?.some((method) => method.type === "oauth")).toBe(true);
    for (const provider of connectableProviders()) {
      if (provider.id === "openai") continue;
      expect(methods[provider.id]?.some((method) => method.type === "oauth")).toBe(false);
    }
  });

  it("keeps openai's API key path alongside oauth", () => {
    const types = providerAuthMethodsById().openai?.map((method) => method.type);
    expect(types).toContain("oauth");
    expect(types).toContain("api");
  });
});

describe("hasEngineOAuthFlow", () => {
  it("is true only for openai", () => {
    expect(hasEngineOAuthFlow("openai")).toBe(true);
    expect(hasEngineOAuthFlow("anthropic")).toBe(false);
    expect(hasEngineOAuthFlow("openrouter")).toBe(false);
  });
});

describe("catalog integrity", () => {
  it("has unique provider ids", () => {
    const ids = CONNECTABLE_PROVIDERS.map((provider) => provider.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every provider a non-empty name and a wire api", () => {
    for (const provider of CONNECTABLE_PROVIDERS) {
      expect(provider.name.trim().length).toBeGreaterThan(0);
      expect(["responses", "chatcompletions"]).toContain(provider.wireApi);
    }
  });
});
