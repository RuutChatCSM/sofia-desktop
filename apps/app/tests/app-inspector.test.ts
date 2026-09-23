import { describe, expect, test } from "bun:test";

import {
  ensureInspectorInstalled,
  publishInspectorOpencodeClient,
} from "../src/app/lib/app-inspector";
import { createClient } from "../src/app/lib/opencode";

describe("app inspector Sofia engine client", () => {
  test("tracks the latest published client and clears it safely", () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {},
    });
    ensureInspectorInstalled();

    const first = createClient("http://127.0.0.1:3000");
    const second = createClient("http://127.0.0.1:3001");
    const disposeFirst = publishInspectorOpencodeClient(first);
    const disposeSecond = publishInspectorOpencodeClient(second);

    expect(window.__sofia?.opencode).toBe(second);
    disposeFirst();
    expect(window.__sofia?.opencode).toBe(second);
    disposeSecond();
    expect(window.__sofia?.opencode).toBeNull();
  });
});
