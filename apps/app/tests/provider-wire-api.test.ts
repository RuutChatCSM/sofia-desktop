// Coverage for the provider -> engine wire mapping the app pushes to the
// bundled engine. Anthropic must speak its native Messages wire instead of the
// OpenAI-compatible chat completions the app used to force on every
// non-OpenAI provider.
import { describe, expect, test } from "bun:test";

import { wireApiForProvider } from "../src/app/utils/providers";

describe("wireApiForProvider", () => {
  test("selects the native Anthropic wire, case-insensitively", () => {
    expect(wireApiForProvider("anthropic")).toBe("anthropic");
    expect(wireApiForProvider("Anthropic")).toBe("anthropic");
    expect(wireApiForProvider("  anthropic  ")).toBe("anthropic");
  });

  test("selects Responses for OpenAI", () => {
    expect(wireApiForProvider("openai")).toBe("responses");
    expect(wireApiForProvider("OpenAI")).toBe("responses");
  });

  test("defaults every other provider to chat completions", () => {
    expect(wireApiForProvider("deepseek")).toBe("chatcompletions");
    expect(wireApiForProvider("openrouter")).toBe("chatcompletions");
  });
});
