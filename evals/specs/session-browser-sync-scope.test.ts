import { expect } from "vitest";
import { test } from "@sofia/testkit";
import type { BrowserStatePayload } from "../../apps/app/src/app/lib/desktop";
import { subscribeSessionBrowserTabs } from "../../apps/app/src/react-app/domains/session/panel/use-side-panel-tabs";

function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error("Promise not initialized"); };
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function flush() { await new Promise<void>((done) => setImmediate(done)); }

test("native scope activation precedes reads and unrelated scope events cannot remove restored tabs", async () => {
  const activation = deferred<string>();
  const read = deferred<BrowserStatePayload>();
  const applied: BrowserStatePayload[] = [];
  const calls: string[] = [];
  let emit: (state: BrowserStatePayload) => void = () => {};
  let unsubscribed = false;
  const dispose = subscribeSessionBrowserTabs({
    setScope: (scope) => { calls.push(scope); return activation.promise; },
    getState: () => { calls.push("getState"); return read.promise; },
    onStateChange: (callback) => { emit = callback; return () => { unsubscribed = true; }; },
  }, "session:one", (state) => applied.push(state), () => {});
  emit({ scopeId: "session:old", tabs: [] });
  emit({ scopeId: "session:one", tabs: [] });
  expect(applied).toEqual([]);
  expect(calls).toEqual(["session:one"]);
  activation.resolve("session:one");
  await flush();
  expect(calls).toEqual(["session:one", "getState"]);
  emit({ scopeId: "session:old", tabs: [] });
  emit({ tabs: [] });
  expect(applied).toEqual([]);
  emit({ scopeId: "session:one", activeTabId: "current", tabs: [] });
  expect(applied).toHaveLength(1);
  dispose();
  read.resolve({ scopeId: "session:one", tabs: [] });
  await flush();
  emit({ scopeId: "session:one", tabs: [] });
  expect(applied).toHaveLength(1);
  expect(unsubscribed).toBe(true);
});

test("switching sessions while scope activation is pending cancels the stale read", async () => {
  const activation = deferred<string>();
  let reads = 0;
  const applied: BrowserStatePayload[] = [];
  const dispose = subscribeSessionBrowserTabs({
    setScope: () => activation.promise,
    getState: async () => { reads++; return { scopeId: "session:old", tabs: [] }; },
  }, "session:old", (state) => applied.push(state), () => {});
  dispose();
  activation.resolve("session:old");
  await flush();
  expect(reads).toBe(0);
  expect(applied).toEqual([]);
});
