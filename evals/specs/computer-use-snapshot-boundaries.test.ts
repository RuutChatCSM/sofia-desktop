import { expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { needs, test } from "@sofia/testkit";

const run = promisify(execFile);

const title = process.platform === "darwin"
  ? "Computer Use pages stable refs, rejects replaced elements, and guards foreground input"
  : "Computer Use snapshot checks skipped — needs: macOS";

test.skipIf(process.platform !== "darwin")(title, async () => {
  needs({ commands: ["swift"], placement: "local" });
  const { stdout, stderr } = await run("swift", ["test", "--package-path", fileURLToPath(new URL("../../packages/handsfree/native/HandsFree", import.meta.url))], {
    timeout: 180_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  expect(stdout + stderr).toContain("Executed 3 tests, with 0 failures");
}, 200_000);
