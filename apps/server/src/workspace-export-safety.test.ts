import { describe, expect, test } from "bun:test";

import {
  collectWorkspaceExportWarnings,
  stripSensitiveWorkspaceExportData,
} from "./workspace-export-safety.js";

describe("workspace export safety", () => {
  test("does not warn for benign portable files", () => {
    const warnings = collectWorkspaceExportWarnings({
      files: [
        { path: ".sofia/plugins/demo/index.ts", content: "const key = 'primary'; export default { enabled: true }" },
        { path: ".sofia/tools/run.ts", content: "console.log('hello')" },
      ],
    });

    expect(warnings).toEqual([]);
  });

  test("ignores workspace files outside the portable roots", () => {
    const warnings = collectWorkspaceExportWarnings({
      files: [{ path: "src/secrets.ts", content: "const apiKey = 'abc123456789';" }],
    });

    expect(warnings).toEqual([]);
  });

  test("warns only when secret-like keys or values are present", () => {
    const warnings = collectWorkspaceExportWarnings({
      files: [
        { path: ".sofia/plugins/demo/index.ts", content: "const apiKey = 'abc123456789';" },
        {
          path: ".sofia/tools/run.ts",
          content: 'const key = "AbCdEf1234567890+/token"; fetch("https://example.com/path/with/a/really/long/url/that/looks/suspicious/123456789")',
        },
      ],
    });

    expect(warnings.map((warning) => warning.id)).toEqual([
      "portable-file:.sofia/plugins/demo/index.ts",
      "portable-file:.sofia/tools/run.ts",
    ]);
    expect(warnings[0]?.detail).toContain("apiKey");
    expect(warnings[1]?.detail).toContain("key");
    expect(warnings[1]?.detail).toContain("long URL");
  });

  test("exclude mode removes only flagged files", () => {
    const sanitized = stripSensitiveWorkspaceExportData({
      files: [
        { path: ".sofia/plugins/demo/index.ts", content: "const token = 'secret';" },
        { path: ".sofia/tools/run.ts", content: "console.log('safe tool');" },
        { path: ".sofia/agents/reviewer.md", content: "agent" },
      ],
    });

    expect(sanitized.files).toEqual([
      { path: ".sofia/tools/run.ts", content: "console.log('safe tool');" },
      { path: ".sofia/agents/reviewer.md", content: "agent" },
    ]);
  });
});
