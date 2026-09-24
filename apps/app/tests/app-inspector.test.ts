import { describe, expect, test } from "bun:test";

import {
  ensureInspectorInstalled,
  publishInspectorWorkspaceEngineClient,
} from "../src/app/lib/app-inspector";
import { createClient } from "../src/app/lib/engine";

describe("app inspector Sofia engine client", () => {
  test("tracks the latest published client and clears it safely", () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {},
    });
    ensureInspectorInstalled();

    const first = createClient("http://127.0.0.1:3000");
    const second = createClient("http://127.0.0.1:3001");
    const disposeFirst = publishInspectorWorkspaceEngineClient(first);
    const disposeSecond = publishInspectorWorkspaceEngineClient(second);

    expect(window.__sofia?.engine).toBe(second);
    disposeFirst();
    expect(window.__sofia?.engine).toBe(second);
    disposeSecond();
    expect(window.__sofia?.engine).toBeNull();
  });
});
