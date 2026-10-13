import { expect } from "vitest";
import { test } from "@sofia/testkit";
import { stripInjectedCodexContext } from "../../apps/app/src/react-app/domains/session/sync/codex-context-fragments";

test("imported page metadata is hidden without removing the user request", () => {
  expect(stripInjectedCodexContext('<external_codex_apps_open_page>{"page_id":null}</external_codex_apps_open_page>')).toBe("");
  expect(stripInjectedCodexContext('<external_codex_apps_open_page>{"page_id":null}</external_codex_apps_open_page>\nReview this project')).toBe("Review this project");
});

test("ordinary user examples containing page tags are preserved", () => {
  const example = 'Explain this tag: <external_codex_apps_open_page>{"page_id":null}</external_codex_apps_open_page>';
  expect(stripInjectedCodexContext(example)).toBe(example);
});
