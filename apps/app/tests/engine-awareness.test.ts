import { describe, expect, test } from "bun:test";

import { isCodexSessionId, shouldActivateCodexEngine } from "../src/react-app/domains/session/engine-awareness";

// Regression: opening a codex session under the opencode engine left the view
// empty because the codex transcript was never mirrored. Engine awareness must
// route by the *open session's* owner, not only the selected engine.
describe("engine awareness", () => {
  test("recognizes codex session ids", () => {
    expect(isCodexSessionId("codex-01a05ed6-3cc7-7eb2-9c25-2d24d682e8c4")).toBe(true);
    expect(isCodexSessionId("opencode-123")).toBe(false);
    expect(isCodexSessionId(null)).toBe(false);
    expect(isCodexSessionId(undefined)).toBe(false);
  });

  test("selected codex engine always activates", () => {
    expect(shouldActivateCodexEngine("codex", null)).toBe(true);
    expect(shouldActivateCodexEngine("codex", "opencode-1")).toBe(true);
  });

  test("opening a codex session activates the codex path under the opencode engine", () => {
    expect(shouldActivateCodexEngine("opencode", "codex-1")).toBe(true);
  });

  test("opencode engine with a non-codex session stays on opencode", () => {
    expect(shouldActivateCodexEngine("opencode", "opencode-1")).toBe(false);
    expect(shouldActivateCodexEngine("opencode", null)).toBe(false);
  });
});
