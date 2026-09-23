import { describe, expect, test } from "bun:test";

import { isCodexSessionId, shouldActivateCodexEngine } from "../src/react-app/domains/session/engine-awareness";

describe("engine awareness", () => {
  test("recognizes codex session ids", () => {
    expect(isCodexSessionId("codex-01a05ed6-3cc7-7eb2-9c25-2d24d682e8c4")).toBe(true);
    expect(isCodexSessionId("opencode-123")).toBe(false);
    expect(isCodexSessionId(null)).toBe(false);
    expect(isCodexSessionId(undefined)).toBe(false);
  });

  test("the codex engine always activates", () => {
    expect(shouldActivateCodexEngine("codex", null)).toBe(true);
    expect(shouldActivateCodexEngine("codex", "opencode-1")).toBe(true);
    expect(shouldActivateCodexEngine("codex", "codex-1")).toBe(true);
  });
});
