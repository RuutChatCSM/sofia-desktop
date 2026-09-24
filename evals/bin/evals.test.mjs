import test from "node:test";
import assert from "node:assert/strict";

import {
  consentVarsFromSource,
  exitCodeFor,
  parseArgs,
  resolveRunEnvironment,
  summarize,
  verdictFor,
} from "./evals.mjs";

test("consentVarsFromSource extracts, deduplicates, and sorts only opt-in variables", () => {
  const source = `
    needs({ optIn: ["SOFIA_EVAL_ZETA", 'SOFIA_EVAL_ALPHA'] });
    const requirements = {
      optIn: [
        "SOFIA_EVAL_MULTI",
        "SOFIA_EVAL_ALPHA",
      ],
    };
    process.env.SOFIA_EVAL_DIRECT === "1";
    process.env.SOFIA_EVAL_TRIMMED?.trim() === "1";
    process.env.SOFIA_EVAL_MODEL?.trim() || "";
    process.env.SOFIA_EVAL_DEN_API_URL?.trim();
    process.env.UNRELATED === "1";
  `;

  assert.deepEqual(consentVarsFromSource(source), [
    "SOFIA_EVAL_ALPHA",
    "SOFIA_EVAL_DIRECT",
    "SOFIA_EVAL_MULTI",
    "SOFIA_EVAL_TRIMMED",
    "SOFIA_EVAL_ZETA",
  ]);
});

test("parseArgs maps run and publish flags", () => {
  assert.deepEqual(parseArgs(["app-smoke", "--with-llm-vision", "--daytona", "--den", "https://den.example"]), {
    testNames: ["app-smoke"],
    withLlmVision: true,
    local: false,
    daytona: true,
    publish: false,
    dryRun: false,
    force: false,
    help: false,
    den: "https://den.example",
  });
  assert.deepEqual(parseArgs(["--publish", "--pr", "42", "--test-run", "latest", "--dry-run", "--force"]), {
    testNames: [],
    withLlmVision: false,
    local: false,
    daytona: false,
    publish: true,
    dryRun: true,
    force: true,
    help: false,
    pr: "42",
    testRun: "latest",
  });
});

test("parseArgs validates values, exclusivity, and unknown flags", () => {
  assert.throws(() => parseArgs(["--den"]), /--den requires a value/);
  assert.throws(() => parseArgs(["--publish", "--dry-run", "app-smoke"]), /mutually exclusive with test names/);
  assert.throws(() => parseArgs(["--publish", "--pr", "1", "--den", "x"]), /mutually exclusive with --den/);
  assert.throws(() => parseArgs(["app-smoke", "--local", "--daytona"]), /--local is mutually exclusive with --daytona/);
  assert.throws(() => parseArgs(["app-smoke", "--local", "--den", "https:\/\/den.example"]), /--local is mutually exclusive with --den/);
  assert.throws(() => parseArgs(["--unknown"]), /Unknown flag: --unknown/);
});

test("explicit local placement removes inherited remote provisioning inputs", () => {
  const options = parseArgs(["app-smoke", "--local"]);
  const childEnv = resolveRunEnvironment(options, {
    PATH: "/bin",
    SOFIA_EVAL_DAYTONA: "1",
    SOFIA_EVAL_DAYTONA_SANDBOX: "desktop-sandbox",
    SOFIA_EVAL_DAYTONA_SANDBOX_ID: "legacy-sandbox",
    SOFIA_EVAL_DAYTONA_DEN_SANDBOX: "den-sandbox",
    SOFIA_EVAL_DAYTONA_DESKTOP_SANDBOX: "prepared-desktop",
    SOFIA_EVAL_DEN_API_URL: "https://den-api.example.test",
    SOFIA_EVAL_DEN_WEB_URL: "https://den.example.test",
  });

  assert.deepEqual(childEnv, { PATH: "/bin" });
});

test("explicit Daytona and attached Den placement retain their existing behavior", () => {
  const daytona = resolveRunEnvironment(parseArgs(["app-smoke", "--daytona"]), {
    SOFIA_EVAL_DEN_API_URL: "https://attached.example.test",
  });
  assert.equal(daytona.SOFIA_EVAL_DAYTONA, "1");
  assert.equal(daytona.SOFIA_EVAL_DEN_API_URL, "https://attached.example.test");

  const attached = resolveRunEnvironment(parseArgs(["app-smoke", "--den", "https://den.example.test"]), {});
  assert.equal(attached.SOFIA_EVAL_DEN_API_URL, "https://den.example.test");
});

test("automatic placement preserves the caller environment", () => {
  const ambient = {
    SOFIA_EVAL_DAYTONA: "1",
    SOFIA_EVAL_DEN_API_URL: "https://den.example.test",
  };
  assert.deepEqual(resolveRunEnvironment(parseArgs(["app-smoke"]), ambient), ambient);
});

test("verdict and exit mapping covers failed, incomplete, and passed runs", () => {
  const failed = verdictFor({ failed: 1, skipped: 0 });
  assert.equal(failed, "failed");
  assert.equal(exitCodeFor(failed, { named: true }), 1);

  const incomplete = verdictFor({ failed: 0, skipped: 1 });
  assert.equal(incomplete, "incomplete");
  assert.equal(exitCodeFor(incomplete, { named: true }), 2);
  assert.equal(exitCodeFor(incomplete, { named: false }), 0);

  const passed = verdictFor({ failed: 0, skipped: 0 });
  assert.equal(passed, "passed");
  assert.equal(exitCodeFor(passed, { named: true }), 0);
});

test("summarize reads counts and skipped test details", () => {
  assert.deepEqual(summarize({
    numPassedTests: 1,
    numFailedTests: 0,
    numPendingTests: 1,
    testResults: [{
      name: "/repo/evals/specs/app-smoke.e2e.test.ts",
      assertionResults: [
        { status: "passed", title: "runs" },
        { status: "pending", title: "needs provider" },
      ],
    }],
  }), {
    passed: 1,
    failed: 0,
    skipped: 1,
    skips: [{ file: "app-smoke.e2e.test.ts", title: "needs provider" }],
  });
});
