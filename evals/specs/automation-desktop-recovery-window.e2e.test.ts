import { createServer } from "node:http";
import { expect, onTestFinished } from "vitest";
import { denFetch } from "@sofia/behaviors";
import type { DenSession } from "@sofia/behaviors";
import {
  eventually,
  needs,
  server,
  test,
} from "@sofia/testkit";

const PROVIDER_NAME = "Recovery Window Gateway";
const PROVIDER_KEY = "recovery-window-gateway";
const PROVIDER_ENV = "RECOVERY_WINDOW_API_KEY";
const MODEL_ID = "recovery-window-model";
const MODEL_NAME = "Recovery Window Model";
const PROVIDER_API_KEY = "sk-recovery-window-local-only";
const REQUEST_TIMEOUT_MS = 10_000;
const AUTOMATION_MODEL_ATTENTION_CAPABILITY = "model_attention_v1";
const RECOVERY_WINDOW_MS = 20_000;
const MANUAL_WINDOW_MS = 60_000;
const MISSED_NEVER_CONNECTED = "Missed — no desktop was connected.";
const MISSED_SILENT_DESKTOP = "Missed — the connected desktop did not pick this up in time.";
const MISSED_BUSY_DESKTOP = "Missed — the desktop was busy with another Automation run.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function auth(session: DenSession): Record<string, string> {
  return { authorization: `Bearer ${session.token}` };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A models-only provider: no synthetic run in this spec may reach completions. */
function startProviderMock(completionCalls: unknown[]): Promise<string> {
  const mock = createServer((request, response) => {
    const url = request.url ?? "";
    if (request.method === "GET" && url.startsWith("/v1/models")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: [{ id: MODEL_ID, object: "model" }] }));
      return;
    }
    if (request.method === "POST" && (url === "/v1/chat/completions" || url === "/chat/completions")) {
      completionCalls.push(url);
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "No completion belongs in this spec" } }));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "not found" } }));
  });
  return new Promise((resolve, reject) => {
    mock.once("error", reject);
    mock.listen(0, "127.0.0.1", () => {
      const address = mock.address();
      if (!address || typeof address === "string") {
        reject(new Error("Recovery provider mock did not bind a TCP port."));
        return;
      }
      onTestFinished(async () => {
        await new Promise<void>((closeResolve, closeReject) => {
          mock.close((error) => error ? closeReject(error) : closeResolve());
          mock.closeAllConnections();
        });
      });
      resolve(`http://127.0.0.1:${address.port}/v1`);
    });
  });
}

async function organizationId(session: DenSession): Promise<string> {
  const result = await denFetch(session, "/v1/me/orgs", {
    headers: auth(session),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const organizations = isRecord(result.body) ? records(result.body.orgs) : [];
  const active = organizations.find((organization) => organization.isActive === true) ?? organizations[0];
  const id = active && typeof active.id === "string" ? active.id : "";
  expect(result.response.status, result.text).toBe(200);
  expect(id).not.toBe("");
  return id;
}

async function createProvider(
  admin: DenSession,
  orgId: string,
  baseUrl: string,
): Promise<string> {
  const result = await denFetch(admin, "/v1/llm-providers", {
    method: "POST",
    headers: { ...auth(admin), "x-sofia-org-id": orgId },
    body: JSON.stringify({
      name: PROVIDER_NAME,
      source: "custom",
      customConfig: {
        id: PROVIDER_KEY,
        name: PROVIDER_NAME,
        npm: "@ai-sdk/openai-compatible",
        env: [PROVIDER_ENV],
        api: baseUrl,
        models: [{ id: MODEL_ID, name: MODEL_NAME }],
      },
      apiKey: PROVIDER_API_KEY,
      allMembers: true,
      memberIds: [],
      teamIds: [],
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const provider = isRecord(result.body) && isRecord(result.body.llmProvider)
    ? result.body.llmProvider
    : null;
  const id = provider && typeof provider.id === "string" ? provider.id : "";
  expect(result.response.status, result.text).toBe(201);
  expect(id).not.toBe("");
  return id;
}

async function createAutomation(
  admin: DenSession,
  orgId: string,
  input: { name: string; providerId: string },
): Promise<string> {
  const result = await denFetch(admin, "/v1/automations", {
    method: "POST",
    headers: { ...auth(admin), "x-sofia-org-id": orgId },
    body: JSON.stringify({
      name: input.name,
      instructions: `Synthetic recovery-window occurrence for ${input.name}.`,
      schedule: { kind: "daily", timezone: "UTC", hour: 23, minute: 59 },
      model: { providerId: input.providerId, modelId: MODEL_ID, variant: null },
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const automation = isRecord(result.body) && isRecord(result.body.automation)
    ? result.body.automation
    : null;
  const id = automation && typeof automation.id === "string" ? automation.id : "";
  expect(result.response.status, result.text).toBe(201);
  expect(id).not.toBe("");
  return id;
}

async function scheduleOnce(admin: DenSession, automationId: string, at: number): Promise<void> {
  const result = await denFetch(admin, `/v1/automations/${encodeURIComponent(automationId)}`, {
    method: "PATCH",
    headers: auth(admin),
    body: JSON.stringify({ schedule: { kind: "once", timezone: "UTC", at } }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  expect(result.response.status, result.text).toBe(200);
}

async function listRuns(admin: DenSession, automationId: string): Promise<Record<string, unknown>[]> {
  const result = await denFetch(admin, `/v1/automations/${encodeURIComponent(automationId)}/runs`, {
    headers: auth(admin),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  expect(result.response.status, result.text).toBe(200);
  return isRecord(result.body) ? records(result.body.items) : [];
}

async function waitForRun(
  admin: DenSession,
  automationId: string,
  input: { trigger: "manual" | "scheduled"; label: string; within?: number; where?: (run: Record<string, unknown>) => boolean },
): Promise<Record<string, unknown>> {
  const run = await eventually(async () => {
    const runs = await listRuns(admin, automationId);
    return runs.find((candidate) => candidate.trigger === input.trigger
      && typeof candidate.id === "string"
      && (input.where?.(candidate) ?? true));
  }, {
    within: input.within ?? 90_000,
    intervalMs: 500,
    label: input.label,
    until: (run) => isRecord(run),
  });
  if (!run) throw new Error(`${input.label} disappeared after it was observed.`);
  return run;
}

async function readPresence(admin: DenSession): Promise<Record<string, unknown>> {
  const result = await denFetch(admin, "/v1/automation-runners/presence", {
    headers: auth(admin),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  expect(result.response.status, result.text).toBe(200);
  return isRecord(result.body) ? result.body : {};
}

test("a scheduled Desktop occurrence survives a short runner outage with named missed causes", { timeout: 15 * 60_000 }, async ({ evidence, place }) => {
  needs({ optIn: ["SOFIA_EVAL_E2E_TESTS"] });
  const completionCalls: unknown[] = [];
  const providerBaseUrl = await startProviderMock(completionCalls);
  await using den = await server({
    place,
    env: {
      DEN_AUTOMATIONS_POLL_INTERVAL_MS: "1000",
      DEN_AUTOMATIONS_RUNNER_CLAIM_DEADLINE_MS: String(RECOVERY_WINDOW_MS),
    },
    org: {
      name: `Automation Recovery Window ${Date.now()}`,
      admin: { name: "Recovery Window Admin" },
    },
  });
  const orgId = await organizationId(den.admin);
  const providerId = await createProvider(den.admin, orgId, providerBaseUrl);
  const runnerRequest = (token: string, path: string, options: RequestInit = {}) =>
    denFetch(den.admin, path, {
      ...options,
      headers: { ...options.headers, authorization: `Bearer ${token}` },
    });

  // Phase 1 — before any desktop has ever connected, presence is authoritative
  // about the absence and an expired occurrence names that cause.
  const beforeAnyRunner = await readPresence(den.admin);
  expect(beforeAnyRunner).toEqual({ connected: false, lastSeenAt: null });
  const neverConnectedId = await createAutomation(den.admin, orgId, {
    name: `Never connected ${Date.now()}`,
    providerId,
  });
  await scheduleOnce(den.admin, neverConnectedId, Date.now() + 3_000);
  const neverConnectedRun = await waitForRun(den.admin, neverConnectedId, {
    trigger: "scheduled",
    label: "occurrence due with no desktop ever connected",
  });
  expect(neverConnectedRun.status).toBe("queued");
  const neverConnectedSkipped = await waitForRun(den.admin, neverConnectedId, {
    trigger: "scheduled",
    label: "expired occurrence with no desktop ever connected",
    where: (run) => run.status === "skipped",
  });
  expect(neverConnectedSkipped.error).toMatchObject({
    code: "runner_unavailable",
    message: MISSED_NEVER_CONNECTED,
    retryable: false,
  });
  evidence.recordAssertionEvidence(
    "An occurrence that expires before any desktop ever connected names that cause",
    `Run ${String(neverConnectedSkipped.id)} stayed queued through the recovery window and was then skipped with "${MISSED_NEVER_CONNECTED}" while presence reported no desktop.`,
    true,
  );

  // Phase 2 — an occurrence due while the desktop is away is recovered exactly
  // once by a runner that returns inside the window.
  const recoveredId = await createAutomation(den.admin, orgId, {
    name: `Recovered occurrence ${Date.now()}`,
    providerId,
  });
  await scheduleOnce(den.admin, recoveredId, Date.now() + 3_000);
  const queuedRun = await waitForRun(den.admin, recoveredId, {
    trigger: "scheduled",
    label: "occurrence queued while the desktop is away",
  });
  const queuedRunId = typeof queuedRun.id === "string" ? queuedRun.id : "";
  expect(queuedRun.status).toBe("queued");
  expect(queuedRunId).not.toBe("");

  const mint = await denFetch(den.admin, "/v1/automation-runners/token", {
    method: "POST",
    headers: auth(den.admin),
    body: JSON.stringify({
      runnerId: `recovery-window-runner-${Date.now()}`,
      protocolVersion: 1,
      supportedExecutionTargets: ["desktop"],
      capabilities: [AUTOMATION_MODEL_ATTENTION_CAPABILITY],
      appVersion: "recovery-window-eval",
      platform: "darwin",
      concurrency: 1,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const runnerToken = isRecord(mint.body) && typeof mint.body.token === "string" ? mint.body.token : "";
  expect(mint.response.status, mint.text).toBe(200);
  expect(runnerToken).not.toBe("");

  const work = await runnerRequest(runnerToken, "/v1/automation-runner/work");
  expect(work.response.status, work.text).toBe(200);
  expect(JSON.stringify(work.body)).toContain(queuedRunId);
  const claim = await runnerRequest(
    runnerToken,
    `/v1/automation-runs/${encodeURIComponent(queuedRunId)}/claim`,
    { method: "POST" },
  );
  const assignment = isRecord(claim.body) && isRecord(claim.body.assignment) ? claim.body.assignment : {};
  expect(claim.response.status, claim.text).toBe(200);
  expect(assignment).toMatchObject({ runId: queuedRunId, attempt: 1 });

  const afterRunnerSeen = await readPresence(den.admin);
  expect(afterRunnerSeen.connected).toBe(true);
  expect(typeof afterRunnerSeen.lastSeenAt).toBe("number");

  const completion = await runnerRequest(
    runnerToken,
    `/v1/automation-runs/${encodeURIComponent(queuedRunId)}/complete`,
    {
      method: "POST",
      body: JSON.stringify({
        attempt: 1,
        status: "succeeded",
        sessionId: "recovered-session-1",
        workspaceId: "recovered-workspace-1",
        resultSummary: "Recovered after the desktop returned.",
        usage: { inputTokens: 1, outputTokens: 1, costMicros: null },
        error: null,
      }),
    },
  );
  expect(completion.response.status, completion.text).toBe(200);
  const recoveredReceipt = await denFetch(den.admin, `/v1/automation-runs/${encodeURIComponent(queuedRunId)}`, {
    headers: auth(den.admin),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const recoveredRun = isRecord(recoveredReceipt.body) && isRecord(recoveredReceipt.body.run)
    ? recoveredReceipt.body.run
    : {};
  expect(recoveredRun).toMatchObject({ status: "succeeded", attemptCount: 1 });

  const lateClaim = await runnerRequest(
    runnerToken,
    `/v1/automation-runs/${encodeURIComponent(queuedRunId)}/claim`,
    { method: "POST" },
  );
  expect(lateClaim.response.status, lateClaim.text).toBe(200);
  expect(isRecord(lateClaim.body) ? lateClaim.body.assignment : undefined).toBeNull();
  evidence.recordAssertionEvidence(
    "A desktop returning inside the recovery window runs the occurrence exactly once",
    `Run ${queuedRunId} stayed queued while no runner was connected, was claimed as attempt 1 by the returning runner through the ordinary work query, succeeded with attemptCount 1, and a repeat claim after completion received no assignment.`,
    true,
  );

  // Phase 3 — a desktop Den has seen recently, but which never picks the work
  // up, is distinguished from one that was never there.
  const silentId = await createAutomation(den.admin, orgId, {
    name: `Silent desktop ${Date.now()}`,
    providerId,
  });
  await scheduleOnce(den.admin, silentId, Date.now() + 3_000);
  const silentSkipped = await waitForRun(den.admin, silentId, {
    trigger: "scheduled",
    label: "expired occurrence with a silent desktop",
    where: (run) => run.status === "skipped",
  });
  expect(silentSkipped.error).toMatchObject({
    code: "runner_unavailable",
    message: MISSED_SILENT_DESKTOP,
    retryable: false,
  });

  // Phase 4 — a desktop that is busy with another run is reported exactly.
  const busyHolderId = await createAutomation(den.admin, orgId, {
    name: `Busy holder ${Date.now()}`,
    providerId,
  });
  await scheduleOnce(den.admin, busyHolderId, Date.now() + 3_000);
  const busyHolderRun = await waitForRun(den.admin, busyHolderId, {
    trigger: "scheduled",
    label: "occurrence for the run that keeps the desktop busy",
  });
  const busyHolderRunId = typeof busyHolderRun.id === "string" ? busyHolderRun.id : "";
  const busyClaim = await runnerRequest(
    runnerToken,
    `/v1/automation-runs/${encodeURIComponent(busyHolderRunId)}/claim`,
    { method: "POST" },
  );
  expect(busyClaim.response.status, busyClaim.text).toBe(200);
  expect(isRecord(busyClaim.body) ? busyClaim.body.assignment : undefined).not.toBeNull();

  const busyVictimId = await createAutomation(den.admin, orgId, {
    name: `Busy victim ${Date.now()}`,
    providerId,
  });
  await scheduleOnce(den.admin, busyVictimId, Date.now() + 3_000);
  const busySkipped = await waitForRun(den.admin, busyVictimId, {
    trigger: "scheduled",
    label: "expired occurrence while the desktop is busy",
    where: (run) => run.status === "skipped",
  });
  expect(busySkipped.error).toMatchObject({
    code: "runner_unavailable",
    message: MISSED_BUSY_DESKTOP,
    retryable: false,
  });
  const busyRelease = await runnerRequest(
    runnerToken,
    `/v1/automation-runs/${encodeURIComponent(busyHolderRunId)}/complete`,
    {
      method: "POST",
      body: JSON.stringify({
        attempt: 1,
        status: "succeeded",
        sessionId: "busy-session-1",
        workspaceId: "busy-workspace-1",
        resultSummary: "Busy holder released.",
        usage: { inputTokens: 1, outputTokens: 1, costMicros: null },
        error: null,
      }),
    },
  );
  expect(busyRelease.response.status, busyRelease.text).toBe(200);
  evidence.recordAssertionEvidence(
    "Missed occurrences distinguish a busy desktop from a silent one and one never connected",
    `Three expiries produced three distinct recorded causes: "${MISSED_NEVER_CONNECTED}", "${MISSED_SILENT_DESKTOP}", and "${MISSED_BUSY_DESKTOP}".`,
    true,
  );

  // Phase 5 — a manual run keeps its short deliberate deadline: longer than the
  // tuned scheduled window here, and bounded by the one-minute floor.
  const manualTriggeredAt = Date.now();
  const manualResponse = await denFetch(den.admin, `/v1/automations/${encodeURIComponent(recoveredId)}/run`, {
    method: "POST",
    headers: auth(den.admin),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  expect(manualResponse.response.status, manualResponse.text).toBe(202);
  await sleep(RECOVERY_WINDOW_MS + 10_000);
  const manualStillQueued = await waitForRun(den.admin, recoveredId, {
    trigger: "manual",
    label: "manual run past the tuned scheduled window",
    within: 15_000,
  });
  expect(manualStillQueued.status).toBe("queued");
  const manualSkipped = await waitForRun(den.admin, recoveredId, {
    trigger: "manual",
    label: "manual run expiring at its own deadline",
    where: (run) => run.status === "skipped",
    within: MANUAL_WINDOW_MS + 30_000,
  });
  const manualFinishedAt = typeof manualSkipped.finishedAt === "number" ? manualSkipped.finishedAt : Date.now();
  expect(manualSkipped.error).toMatchObject({
    code: "runner_unavailable",
    message: MISSED_SILENT_DESKTOP,
    retryable: false,
  });
  expect(manualFinishedAt - manualTriggeredAt).toBeGreaterThanOrEqual(MANUAL_WINDOW_MS - 1_000);
  evidence.recordAssertionEvidence(
    "A manual run keeps its deliberate one-minute deadline independent of the recovery window",
    `The manual run was still queued ${Math.round((RECOVERY_WINDOW_MS + 10_000) / 1000)}s after triggering — past the ${RECOVERY_WINDOW_MS / 1000}s scheduled window — and expired at ${Math.round((manualFinishedAt - manualTriggeredAt) / 1000)}s with the recorded silent-desktop cause.`,
    true,
  );

  expect(completionCalls).toHaveLength(0);
});
