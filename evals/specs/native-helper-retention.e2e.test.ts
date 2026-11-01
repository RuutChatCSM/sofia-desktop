import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { desktop } from "@sofia/hosts";
import { needs, test } from "@sofia/testkit";
import { expect } from "vitest";

const execute = promisify(execFile);

test("desktop preparation retains the existing native helper binary and signing requirement", { timeout: 180_000 }, async ({ evidence }) => {
  needs({ optIn: ["SOFIA_EVAL_E2E_TESTS"], placement: "local" });
  if (process.platform !== "darwin") throw new Error("needs: macOS code signing");
  // This proves default resource preparation, rather than bypassing that path.
  expect(process.env.SOFIA_EVAL_ELECTRON_RESOURCES_PREPARED).not.toBe("1");
  expect(process.env.SOFIA_COMPUTER_USE_FORCE_BUILD).not.toBe("1");
  const helper = resolve(import.meta.dirname, "../../apps/desktop/resources/helpers/Sofia Computer Use.app/Contents/MacOS/ComputerUse");
  const identity = async () => {
    const executable = await readFile(helper);
    const { stdout, stderr } = await execute("codesign", ["-d", "-r-", helper]);
    const requirement = `${stdout}\n${stderr}`.split("\n").find(line => /^(?:# )?designated =>/.test(line));
    if (!requirement) throw new Error("Existing native helper has no designated code signing requirement");
    return { sha256: createHash("sha256").update(executable).digest("hex"), requirement };
  };
  const before = await identity();
  expect(before.sha256).toMatch(/^[a-f0-9]{64}$/);
  await using app = await desktop({ name: "native-helper-retention" });
  expect(app.readiness.state).toBeTruthy();
  const after = await identity();
  expect(after.sha256).toBe(before.sha256);
  expect(after.requirement).toBe(before.requirement);
  await mkdir(evidence.dir, { recursive: true });
  await writeFile(join(evidence.dir, "native-helper-identity.json"), JSON.stringify({ helper, before, after }, null, 2));
  evidence.recordAssertionEvidence("Native helper identity retention", "An actual isolated desktop launch runs default shared resource preparation without its prepared bypass. The existing helper executable SHA-256 and designated code signing requirement are exactly unchanged; no native input or permission grants are needed.", true);
});
