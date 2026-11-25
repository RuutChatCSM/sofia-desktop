import { expect } from "vitest";
import { test } from "@sofia/testkit";
import { runCodexStream, useCodexSessionStore } from "../../apps/app/src/react-app/domains/session/codex-session-store";
import type { CodexEvent, CodexSessionClient } from "../../apps/app/src/app/lib/codex-session";

function client(): CodexSessionClient {
  return {
    stream: (signal: AbortSignal, onEvent: (event: CodexEvent) => void) => {
      onEvent({ type: "stream.ready", streamId: "s" });
      return new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    },
  } as unknown as CodexSessionClient;
}

test("a replaced stream winding down cannot mark the live one as reconnecting", async () => {
  useCodexSessionStore.getState().clear();
  const first = new AbortController();
  const firstRun = runCodexStream(client(), first.signal);
  const second = new AbortController();
  const secondRun = runCodexStream(client(), second.signal);
  first.abort();
  await firstRun;
  expect(useCodexSessionStore.getState().streaming).toBe(true);
  second.abort();
  await secondRun;
  expect(useCodexSessionStore.getState().streaming).toBe(false);
});
