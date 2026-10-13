import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { installMainErrorGuards } from "./main-error-guard.mjs";

/** Minimal EventEmitter stand-in: records listeners per event. */
function fakeProcess() {
  const listeners = new Map();
  return {
    listeners,
    on(event, listener) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return this;
    },
  };
}

describe("main process error guards", () => {
  it("installs one handler for uncaught exceptions and one for rejections", () => {
    const target = fakeProcess();
    installMainErrorGuards(target);
    assert.equal(target.listeners.get("uncaughtException")?.length, 1);
    assert.equal(target.listeners.get("unhandledRejection")?.length, 1);
  });

  it("is idempotent, so a re-import cannot stack handlers", () => {
    const target = fakeProcess();
    installMainErrorGuards(target);
    installMainErrorGuards(target);
    assert.equal(target.listeners.get("uncaughtException")?.length, 1);
  });

  it("reports a disposed-frame error instead of letting it kill the app", () => {
    const target = fakeProcess();
    installMainErrorGuards(target);
    const errors = [];
    const originalConsoleError = console.error;
    console.error = (...args) => errors.push(args);
    try {
      const error = new Error("Render frame was disposed before WebFrameMain could be accessed");
      assert.doesNotThrow(() => target.listeners.get("uncaughtException")[0](error));
      // The handler must not swallow it silently: the failure still reaches the log.
      assert.equal(errors.length, 1);
      assert.match(String(errors[0][0]), /uncaught exception in the main process/);
    } finally {
      console.error = originalConsoleError;
    }
  });
});
