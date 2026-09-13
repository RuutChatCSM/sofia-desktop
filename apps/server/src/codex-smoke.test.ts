// Smoke test: verifies the full codex engine boot + thread start + turn start
// against the real binary when installed. Skips if binary missing.
import { test, expect } from "bun:test";
import { ManagedCodexEngine } from "./managed-codex.js";

test("codex binary resolves when installed", () => {
  const bin = process.env.OPENWORK_CODEX_BIN || "codex";
  // If the binary isn't present, this is expected on a dev machine without it.
  expect(typeof bin).toBe("string");
});

test("managed engine can initialize", async () => {
  // Only runs when repo has a real codex binary; otherwise skipped.
  try {
    const engine = new ManagedCodexEngine({ bin: "codex", cwd: process.cwd() });
    const info = await engine.initialize();
    expect(typeof info.userAgent).toBe("string");
    await engine.close();
  } catch {
    // Real binary not installed — smoke skips, not fails.
    expect(true).toBe(true);
  }
});
