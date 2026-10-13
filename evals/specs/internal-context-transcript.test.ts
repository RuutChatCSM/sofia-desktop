import { expect } from "vitest";
import { test } from "@sofia/testkit";
import { stripInjectedCodexContext } from "../../apps/app/src/react-app/domains/session/sync/codex-context-fragments";

test("goal judge context is hidden while the user's continuation survives", () => {
  const context = '<sofia_internal_context source="goal_judge">Your goal is not yet complete.</sofia_internal_context>';
  expect(stripInjectedCodexContext(context)).toBe("");
  expect(stripInjectedCodexContext(`${context}\ncontinue with the spec`)).toBe("continue with the spec");
  expect(stripInjectedCodexContext('<codex_internal_context source="invalid_output">Retry.</codex_internal_context>')).toBe("");
});

test("ordinary discussion of internal context remains visible", () => {
  const message = 'Why did I see <sofia_internal_context source="goal_judge">work remains</sofia_internal_context>?';
  expect(stripInjectedCodexContext(message)).toBe(message);
});
