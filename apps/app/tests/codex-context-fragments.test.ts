import { describe, expect, test } from "bun:test";

import { stripInjectedCodexContext } from "../src/react-app/domains/session/sync/codex-context-fragments";

// Shape captured from a `codex exec` rollout (2026-09-01): the model-facing
// user message is entirely injected context, which the app used to render as if
// the user had typed it.
const INJECTED_CONTEXT = [
  "<recommended_plugins>",
  "Here is a list of plugins that are available but not installed.",
  "",
  "- Airtable (airtable@openai-curated-remote)",
  "</recommended_plugins>",
  "# AGENTS.md instructions for /Users/mona/Dev/tools/codex/codex-rs",
  "",
  "<INSTRUCTIONS>",
  "# Rust/codex-rs",
  "- Crate names are prefixed with `codex-`.",
  "</INSTRUCTIONS>",
  "<environment_context>",
  "  <cwd>/Users/mona/Dev/tools/codex/codex-rs</cwd>",
  "  <shell>zsh</shell>",
  "</environment_context>",
].join("\n");

describe("codex injected context fragments", () => {
  test("a context-only user message collapses to nothing", () => {
    expect(stripInjectedCodexContext(INJECTED_CONTEXT)).toBe("");
  });

  test("keeps the typed prompt that follows the injected context", () => {
    expect(stripInjectedCodexContext(`${INJECTED_CONTEXT}\nWhat model are you?`)).toBe("What model are you?");
  });

  test("leaves an ordinary prompt untouched", () => {
    const prompt = "why do i now get this dump on every session?";
    expect(stripInjectedCodexContext(prompt)).toBe(prompt);
  });

  test("strips the newer fragment shapes too", () => {
    expect(stripInjectedCodexContext("<skills_instructions>\n## Skills\n</skills_instructions>\nhi")).toBe("hi");
    expect(stripInjectedCodexContext("<recovered_thread_context>\nUser: earlier\n</recovered_thread_context>\ncarry on")).toBe("carry on");
  });
});
