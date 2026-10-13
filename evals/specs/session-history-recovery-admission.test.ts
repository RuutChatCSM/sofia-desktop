import { expect } from "vitest";
import { test } from "@sofia/testkit";
import { createSessionHistoryRecovery } from "../../apps/app/src/react-app/domains/session/sync/reconnect-recovery";

test("terminal history refresh coalesces each thread without blocking another thread", async () => {
  const controller = new AbortController();
  const calls: string[] = [];
  let releaseA = () => {};
  const pendingA = new Promise<void>(resolve => { releaseA = resolve; });
  let finishTrailing = () => {};
  const trailing = new Promise<void>(resolve => { finishTrailing = resolve; });
  const request = createSessionHistoryRecovery(async id => {
    calls.push(id);
    if (id === "a" && calls.filter(value => value === "a").length === 1) await pendingA;
    else if (id === "a") finishTrailing();
  }, controller.signal, error => { throw error; });
  request("a");
  request("a");
  request("a");
  request("b");
  expect(calls).toEqual(["a", "b"]);
  releaseA();
  await trailing;
  expect(calls).toEqual(["a", "b", "a"]);
  controller.abort();
  request("c");
  expect(calls).toEqual(["a", "b", "a"]);
});
