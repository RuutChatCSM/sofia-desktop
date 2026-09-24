import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, onTestFinished } from "vitest";
import {
  clickButton,
  clickText,
  denFetch,
  evalIn,
  go,
  readAvailableModels,
  visibleText,
  waitForText,
} from "@sofia/behaviors";
import type { DenSession } from "@sofia/behaviors";
import type { Surface } from "@sofia/cdp";
import {
  app,
  eventually,
  needs,
  server,
  test,
} from "@sofia/testkit";

const PROVIDER_NAME = "Automation Reliability Gateway";
const PROVIDER_KEY = "automation-reliability-gateway";
const PROVIDER_ENV = "AUTOMATION_RELIABILITY_API_KEY";
const MODEL_ID = "automation-reliability-model";
const MODEL_NAME = "Automation Reliability Model";
const REPLY = "The synthetic Automation lifecycle completed successfully.";
const PROVIDER_API_KEY = "sk-automation-reliability-local-only";
const REQUEST_TIMEOUT_MS = 10_000;
const RUN_TIMEOUT_MS = 180_000;
const AUTOMATION_MODEL_ATTENTION_CAPABILITY = "model_attention_v1";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function auth(session: DenSession): Record<string, string> {
  return { authorization: `Bearer ${session.token}` };
}

function startProviderMock(
  completionBodies: unknown[],
  control: { unavailable?: boolean } = {},
): Promise<string> {
  const mock = createServer((request, response) => {
    const url = request.url ?? "";
    if (request.method === "GET" && url.startsWith("/v1/models")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: [{ id: MODEL_ID, object: "model" }] }));
      return;
    }
    if (request.method === "POST" && (url === "/v1/chat/completions" || url === "/chat/completions")) {
      let rawBody = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => { rawBody += chunk; });
      request.on("end", () => {
        let body: unknown;
        try {
          body = JSON.parse(rawBody);
        } catch {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { message: "invalid JSON request body" } }));
          return;
        }
        completionBodies.push(body);
        if (control.unavailable) {
          response.writeHead(503, { "content-type": "application/json" });
          response.end(JSON.stringify({
            error: { message: "Synthetic provider is temporarily unavailable", type: "provider_unavailable" },
          }));
          return;
        }
        const chunks = [
          { id: `chatcmpl-automation-${completionBodies.length}`, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
          { id: `chatcmpl-automation-${completionBodies.length}`, object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: REPLY }, finish_reason: null }] },
          { id: `chatcmpl-automation-${completionBodies.length}`, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        ];
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
        response.write("data: [DONE]\n\n");
        response.end();
      });
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
        reject(new Error("Automation provider mock did not bind a TCP port."));
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
  apiKey: string,
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
      apiKey,
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
  input: { name: string; instructions: string; providerId: string },
): Promise<{ automationId: string; revisionId: string }> {
  const result = await denFetch(admin, "/v1/automations", {
    method: "POST",
    headers: { ...auth(admin), "x-sofia-org-id": orgId },
    body: JSON.stringify({
      name: input.name,
      instructions: input.instructions,
      schedule: { kind: "daily", timezone: "UTC", hour: 23, minute: 59 },
      model: { providerId: input.providerId, modelId: MODEL_ID, variant: null },
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const automation = isRecord(result.body) && isRecord(result.body.automation)
    ? result.body.automation
    : null;
  const revision = isRecord(result.body) && isRecord(result.body.revision)
    ? result.body.revision
    : null;
  const automationId = automation && typeof automation.id === "string" ? automation.id : "";
  const revisionId = revision && typeof revision.id === "string" ? revision.id : "";
  expect(result.response.status, result.text).toBe(201);
  expect(automation?.state).toBe("active");
  expect(automationId).not.toBe("");
  expect(revisionId).not.toBe("");
  expect(revision?.schedule).toEqual({ kind: "daily", timezone: "UTC", hour: 23, minute: 59 });
  expect(revision?.model).toEqual({ providerId: input.providerId, modelId: MODEL_ID, variant: null });
  return { automationId, revisionId };
}

async function listRuns(admin: DenSession, automationId: string): Promise<Record<string, unknown>[]> {
  const result = await denFetch(admin, `/v1/automations/${encodeURIComponent(automationId)}/runs`, {
    headers: auth(admin),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  expect(result.response.status, result.text).toBe(200);
  return isRecord(result.body) ? records(result.body.items) : [];
}

async function waitForNewRun(
  admin: DenSession,
  automationId: string,
  before: Set<string>,
  trigger: "manual" | "scheduled",
): Promise<Record<string, unknown>> {
  const run = await eventually(async () => {
    const runs = await listRuns(admin, automationId);
    return runs.find((run) => run.trigger === trigger
      && typeof run.id === "string"
      && !before.has(run.id));
  }, {
    within: RUN_TIMEOUT_MS,
    intervalMs: 500,
    label: `new ${trigger} Automation run`,
    until: (run) => isRecord(run),
  });
  if (!run) throw new Error(`The ${trigger} Automation run disappeared after it was observed.`);
  return run;
}

async function waitForTerminalReceipt(
  admin: DenSession,
  runId: string,
): Promise<Record<string, unknown>> {
  return eventually(async () => {
    const result = await denFetch(admin, `/v1/automation-runs/${encodeURIComponent(runId)}`, {
      headers: auth(admin),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    expect(result.response.status, result.text).toBe(200);
    return isRecord(result.body) ? result.body : {};
  }, {
    within: RUN_TIMEOUT_MS,
    intervalMs: 500,
    label: `terminal receipt for ${runId}`,
    until: (receipt) => {
      const run = isRecord(receipt.run) ? receipt.run : null;
      return run !== null && ["succeeded", "failed", "cancelled", "skipped"].includes(String(run.status));
    },
  });
}

async function assertSucceededReceipt(
  receipt: Record<string, unknown>,
  expected: { automationId: string; revisionId?: string },
): Promise<{ runId: string; sessionId: string }> {
  const run = isRecord(receipt.run) ? receipt.run : {};
  const thread = isRecord(run.executionThread) ? run.executionThread : {};
  const events = records(receipt.events);
  const runId = typeof run.id === "string" ? run.id : "";
  const sessionId = typeof thread.nativeThreadId === "string" ? thread.nativeThreadId : "";
  expect(run.status).toBe("succeeded");
  expect(run.automationId).toBe(expected.automationId);
  if (expected.revisionId) expect(run.revisionId).toBe(expected.revisionId);
  expect(run.error).toBeNull();
  expect(run.resultSummary).toContain(REPLY);
  expect(thread).toMatchObject({
    threadKind: "automation",
    executionLocation: "desktop",
    automationId: expected.automationId,
    automationRunId: runId,
    engineKind: "sofia-desktop-runner-v1",
  });
  expect(sessionId).not.toBe("");
  expect(typeof thread.workspaceId).toBe("string");
  expect(events.map((event) => event.type)).toEqual(["user", "assistant", "usage", "terminal"]);
  expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
  return { runId, sessionId };
}

async function openAutomation(surface: Surface, automationId: string, name: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await go(surface, "/automations");
    try {
      await eventually(() => evalIn(surface, "window.location.hash"), {
        within: 30_000,
        intervalMs: 250,
        label: "Automations list route",
        until: (hash) => typeof hash === "string" && /^#\/automations(?:\?|$)/.test(hash),
      });
      await clickText(surface, name, {
        selector: `button[data-automation-id="${automationId}"]`,
        timeoutMs: 30_000,
      });
      await waitForText(surface, "Run now", { timeoutMs: 30_000 });
      return;
    } catch (error) {
      if (attempt === 2) throw error;
    }
  }
}

async function waitForSyntheticModel(surface: Surface): Promise<void> {
  const availableModels = await eventually(() => readAvailableModels(surface), {
    within: 120_000,
    intervalMs: 2_000,
    label: "synced synthetic Automation model",
    until: (models) => models.some((model) => model.selectable
      && (model.id === MODEL_ID || model.id.endsWith(`/${MODEL_ID}`))),
  });
  expect(availableModels.some((model) => model.selectable
    && (model.id === MODEL_ID || model.id.endsWith(`/${MODEL_ID}`)))).toBe(true);
}

async function triggerManualRun(
  admin: DenSession,
  automationId: string,
): Promise<Record<string, unknown>> {
  const before = new Set((await listRuns(admin, automationId)).flatMap((run) =>
    typeof run.id === "string" ? [run.id] : []));
  const response = await denFetch(admin, `/v1/automations/${encodeURIComponent(automationId)}/run`, {
    method: "POST",
    headers: auth(admin),
  });
  expect(response.response.status, response.text).toBe(202);
  return waitForNewRun(admin, automationId, before, "manual");
}

test("a Desktop Automation completes through UI, API, schedule, thread, and receipt", { timeout: 20 * 60_000 }, async ({ evidence, place }) => {
  needs({ optIn: ["SOFIA_EVAL_E2E_TESTS"] });
  const completionBodies: unknown[] = [];
  const providerBaseUrl = await startProviderMock(completionBodies);
  await using den = await server({
    place,
    org: {
      name: `Automation Reliability ${Date.now()}`,
      admin: { name: "Automation Admin" },
      members: { member: { name: "Automation Member" } },
    },
  });
  const orgId = await organizationId(den.admin);
  const providerId = await createProvider(den.admin, orgId, providerBaseUrl, PROVIDER_API_KEY);
  const stamp = Date.now();
  const automationName = `Synthetic lifecycle ${stamp}`;
  const instructions = `Return one concise synthetic reliability result for marker ${stamp}.`;

  const invalid = await denFetch(den.admin, "/v1/automations", {
    method: "POST",
    headers: { ...auth(den.admin), "x-sofia-org-id": orgId },
    body: JSON.stringify({
      name: `Invalid lifecycle ${stamp}`,
      instructions,
      schedule: { kind: "daily", timezone: "Not/A-Timezone", hour: 9, minute: 0 },
      model: { providerId, modelId: MODEL_ID, variant: null },
    }),
  });
  expect(invalid.response.status).toBe(400);
  expect((await denFetch(den.admin, "/v1/automations", { headers: auth(den.admin) })).text)
    .not.toContain(`Invalid lifecycle ${stamp}`);
  evidence.recordAssertionEvidence(
    "Invalid Automation configuration fails without a runnable record",
    "Den rejected the invalid timezone with HTTP 400 and the invalid name was absent from the owner list.",
    true,
  );

  const created = await createAutomation(den.admin, orgId, {
    name: automationName,
    instructions,
    providerId,
  });
  const denied = await denFetch(den.members.member, `/v1/automations/${encodeURIComponent(created.automationId)}`, {
    headers: auth(den.members.member),
  });
  expect(denied.response.status).toBe(404);
  evidence.recordAssertionEvidence(
    "Automation ownership remains member-scoped",
    "A different organization member received HTTP 404 for the owner's Automation.",
    true,
  );

  await using desktop = await app({ den, as: "admin", place });
  await waitForSyntheticModel(desktop);

  await openAutomation(desktop, created.automationId, automationName);
  const beforeUiRun = new Set((await listRuns(den.admin, created.automationId)).flatMap((run) =>
    typeof run.id === "string" ? [run.id] : []));
  const firstProviderCheckpoint = completionBodies.length;
  await clickButton(desktop, "Run now");
  const uiRun = await waitForNewRun(den.admin, created.automationId, beforeUiRun, "manual");
  const uiRunId = typeof uiRun.id === "string" ? uiRun.id : "";
  const uiReceipt = await waitForTerminalReceipt(den.admin, uiRunId);
  const first = await assertSucceededReceipt(uiReceipt, created);
  const firstRequest = await eventually(() => completionBodies[firstProviderCheckpoint], {
    within: RUN_TIMEOUT_MS,
    intervalMs: 250,
    label: "first synthetic provider completion",
    until: (request) => request !== undefined,
  });
  expect(JSON.stringify(firstRequest)).toContain(String(stamp));
  evidence.recordAssertionEvidence(
    "Run now reaches a real desktop session and durable receipt",
    `UI run ${first.runId} created native thread ${first.sessionId}, returned the deterministic assistant result, and committed four ordered events.`,
    true,
  );

  const receipts: Record<string, unknown>[] = [uiReceipt];
  for (let index = 0; index < 2; index += 1) {
    const before = new Set((await listRuns(den.admin, created.automationId)).flatMap((run) =>
      typeof run.id === "string" ? [run.id] : []));
    const response = await denFetch(den.admin, `/v1/automations/${encodeURIComponent(created.automationId)}/run`, {
      method: "POST",
      headers: auth(den.admin),
    });
    expect(response.response.status, response.text).toBe(202);
    const run = await waitForNewRun(den.admin, created.automationId, before, "manual");
    const runId = typeof run.id === "string" ? run.id : "";
    const receipt = await waitForTerminalReceipt(den.admin, runId);
    await assertSucceededReceipt(receipt, created);
    receipts.push(receipt);
  }

  const scheduledAt = Date.now() + 45_000;
  const scheduleResponse = await denFetch(
    den.admin,
    `/v1/automations/${encodeURIComponent(created.automationId)}`,
    {
      method: "PATCH",
      headers: auth(den.admin),
      body: JSON.stringify({ schedule: { kind: "once", timezone: "UTC", at: scheduledAt } }),
    },
  );
  expect(scheduleResponse.response.status, scheduleResponse.text).toBe(200);
  const scheduledRevision = isRecord(scheduleResponse.body) && isRecord(scheduleResponse.body.revision)
    ? scheduleResponse.body.revision
    : {};
  expect(scheduledRevision.schedule).toEqual({ kind: "once", timezone: "UTC", at: scheduledAt });
  const beforeScheduled = new Set((await listRuns(den.admin, created.automationId)).flatMap((run) =>
    typeof run.id === "string" ? [run.id] : []));
  const scheduledRun = await waitForNewRun(den.admin, created.automationId, beforeScheduled, "scheduled");
  const scheduledRunId = typeof scheduledRun.id === "string" ? scheduledRun.id : "";
  const scheduledReceipt = await waitForTerminalReceipt(den.admin, scheduledRunId);
  await assertSucceededReceipt(scheduledReceipt, {
    automationId: created.automationId,
    revisionId: typeof scheduledRevision.id === "string" ? scheduledRevision.id : undefined,
  });
  receipts.push(scheduledReceipt);

  const runIds = receipts.flatMap((receipt) => {
    const run = isRecord(receipt.run) ? receipt.run : {};
    return typeof run.id === "string" ? [run.id] : [];
  });
  const sessionIds = receipts.flatMap((receipt) => {
    const run = isRecord(receipt.run) ? receipt.run : {};
    const thread = isRecord(run.executionThread) ? run.executionThread : {};
    return typeof thread.nativeThreadId === "string" ? [thread.nativeThreadId] : [];
  });
  expect(new Set(runIds).size).toBe(4);
  expect(new Set(sessionIds).size).toBe(4);
  expect(completionBodies.slice(firstProviderCheckpoint)).toHaveLength(4);
  evidence.recordAssertionEvidence(
    "Repeated and scheduled runs remain exactly-once",
    "Three sequential manual runs and one scheduled occurrence produced four unique runs, four unique native sessions, four deterministic model requests, and four terminal receipts.",
    true,
  );

  const scheduledTerminalRun = isRecord(scheduledReceipt.run) ? scheduledReceipt.run : {};
  const scheduledThread = isRecord(scheduledTerminalRun.executionThread)
    ? scheduledTerminalRun.executionThread
    : {};
  const scheduledThreadId = typeof scheduledThread.id === "string" ? scheduledThread.id : "";
  const scheduledWorkspaceId = typeof scheduledThread.workspaceId === "string" ? scheduledThread.workspaceId : "";
  const scheduledSessionId = typeof scheduledThread.nativeThreadId === "string" ? scheduledThread.nativeThreadId : "";
  const receiptQuery = new URLSearchParams({
    automation: created.automationId,
    run: scheduledRunId,
    thread: scheduledThreadId,
  });
  await go(desktop, `/automations?${receiptQuery.toString()}`);
  await clickText(desktop, "Open local thread", {
    selector: `button[data-automation-run-id="${scheduledRunId}"]`,
    timeoutMs: 30_000,
  });
  await eventually(
    () => evalIn(desktop, "window.location.hash"),
    {
      within: 30_000,
      intervalMs: 250,
      label: "native Automation session route",
      until: (hash) => typeof hash === "string"
        && hash.includes(`/workspace/${encodeURIComponent(scheduledWorkspaceId)}/session/${encodeURIComponent(scheduledSessionId)}`),
    },
  );
  await waitForText(desktop, REPLY, { timeoutMs: 30_000 });
  evidence.recordAssertionEvidence(
    "A receipt opens the actual local execution thread",
    `The scheduled receipt exposed workspace ${scheduledWorkspaceId} and session ${scheduledSessionId}; Open local thread navigated to that session and rendered the deterministic assistant result.`,
    true,
  );

  await openAutomation(desktop, created.automationId, automationName);
  const detailText = await visibleText(desktop);
  expect(detailText).toContain("succeeded");
  expect(detailText).toContain(MODEL_NAME);
  expect(detailText).not.toMatch(/running|waiting|no assistant result/i);
  evidence.recordAssertionEvidence(
    "The Automation UI reflects the terminal result and configured model",
    `The detail view showed succeeded with ${MODEL_NAME}, without a stale running, waiting, or missing-result message.`,
    true,
  );
});

test("a Desktop Automation recovers across restart before execution and while work is queued", { timeout: 20 * 60_000 }, async ({ evidence, place }) => {
  needs({ optIn: ["SOFIA_EVAL_E2E_TESTS"] });
  const completionBodies: unknown[] = [];
  const providerBaseUrl = await startProviderMock(completionBodies);
  await using den = await server({
    place,
    org: {
      name: `Automation Recovery ${Date.now()}`,
      admin: { name: "Automation Recovery Admin" },
    },
  });
  const orgId = await organizationId(den.admin);
  const providerId = await createProvider(den.admin, orgId, providerBaseUrl, PROVIDER_API_KEY);
  const stamp = Date.now();
  const created = await createAutomation(den.admin, orgId, {
    name: `Synthetic recovery ${stamp}`,
    instructions: `Return one concise synthetic recovery result for marker ${stamp}.`,
    providerId,
  });
  const profileDir = await mkdtemp(join(tmpdir(), "sofia-automation-recovery-"));
  onTestFinished(() => rm(profileDir, { recursive: true, force: true }));
  let desktop: Awaited<ReturnType<typeof app>> | null = null;

  try {
    desktop = await app({ den, as: "admin", place, profileDir });
    await waitForSyntheticModel(desktop);
    await desktop.stop();
    desktop = null;

    desktop = await app({ den, as: "admin", place, profileDir });
    await waitForSyntheticModel(desktop);
    const postRestartRun = await triggerManualRun(den.admin, created.automationId);
    const postRestartRunId = typeof postRestartRun.id === "string" ? postRestartRun.id : "";
    const postRestartReceipt = await waitForTerminalReceipt(den.admin, postRestartRunId);
    const first = await assertSucceededReceipt(postRestartReceipt, created);
    evidence.recordAssertionEvidence(
      "Desktop restart before execution preserves runner readiness",
      `The same isolated profile relaunched before execution, reminted its runner authority, and run ${first.runId} completed in native session ${first.sessionId}.`,
      true,
    );

    await desktop.stop();
    desktop = null;
    const providerRequestsBeforeConcurrentRuns = completionBodies.length;
    const concurrentResponses = await Promise.all(Array.from({ length: 3 }, () =>
      denFetch(den.admin, `/v1/automations/${encodeURIComponent(created.automationId)}/run`, {
        method: "POST",
        headers: auth(den.admin),
      })));
    for (const response of concurrentResponses) {
      expect(response.response.status, response.text).toBe(202);
    }
    const concurrentRuns = concurrentResponses.map((response) =>
      isRecord(response.body) && isRecord(response.body.run) ? response.body.run : {});
    expect(concurrentRuns.map((run) => run.status).sort()).toEqual(["queued", "skipped", "skipped"]);
    const queuedConcurrentRun = concurrentRuns.find((run) => run.status === "queued");
    const queuedConcurrentRunId = queuedConcurrentRun && typeof queuedConcurrentRun.id === "string"
      ? queuedConcurrentRun.id
      : "";
    const cancelResponse = await denFetch(
      den.admin,
      `/v1/automation-runs/${encodeURIComponent(queuedConcurrentRunId)}/cancel`,
      { method: "POST", headers: auth(den.admin) },
    );
    const cancelledRun = isRecord(cancelResponse.body) && isRecord(cancelResponse.body.run)
      ? cancelResponse.body.run
      : {};
    expect(cancelResponse.response.status, cancelResponse.text).toBe(200);
    expect(cancelledRun.status).toBe("cancelled");
    expect(cancelledRun.executionThread).toBeNull();
    expect(completionBodies).toHaveLength(providerRequestsBeforeConcurrentRuns);
    evidence.recordAssertionEvidence(
      "Concurrent manual requests overlap safely and cancellation before claim is terminal",
      "Three simultaneous manual requests with Desktop absent produced one queued run and two durable overlap skips; cancelling the queued run returned cancelled with no execution thread and no provider request.",
      true,
    );

    const waitingRun = await triggerManualRun(den.admin, created.automationId);
    const waitingRunId = typeof waitingRun.id === "string" ? waitingRun.id : "";
    expect(waitingRun.status).toBe("queued");

    desktop = await app({ den, as: "admin", place, profileDir });
    const waitingReceipt = await waitForTerminalReceipt(den.admin, waitingRunId);
    const second = await assertSucceededReceipt(waitingReceipt, created);
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(completionBodies).toHaveLength(2);
    evidence.recordAssertionEvidence(
      "Queued work survives Desktop absence and relaunch",
      `Run ${second.runId} remained queued while Desktop was stopped; after relaunch a fresh runner credential claimed that same run and exactly one new native session ${second.sessionId} reached a terminal receipt.`,
      true,
    );
  } finally {
    await desktop?.stop();
  }
});

test("a Desktop Automation records a provider outage and succeeds after recovery", { timeout: 10 * 60_000 }, async ({ evidence, place }) => {
  needs({ optIn: ["SOFIA_EVAL_E2E_TESTS"] });
  const completionBodies: unknown[] = [];
  const providerControl = { unavailable: true };
  const providerBaseUrl = await startProviderMock(completionBodies, providerControl);
  await using den = await server({
    place,
    org: {
      name: `Automation Provider Recovery ${Date.now()}`,
      admin: { name: "Automation Provider Recovery Admin" },
    },
  });
  const orgId = await organizationId(den.admin);
  const providerId = await createProvider(den.admin, orgId, providerBaseUrl, PROVIDER_API_KEY);
  const created = await createAutomation(den.admin, orgId, {
    name: `Synthetic provider recovery ${Date.now()}`,
    instructions: "Return a result after the synthetic provider recovers.",
    providerId,
  });
  await using desktop = await app({ den, as: "admin", place });
  await waitForSyntheticModel(desktop);

  const failedRun = await triggerManualRun(den.admin, created.automationId);
  const failedRunId = typeof failedRun.id === "string" ? failedRun.id : "";
  const failedReceipt = await waitForTerminalReceipt(den.admin, failedRunId);
  const failed = isRecord(failedReceipt.run) ? failedReceipt.run : {};
  const failedThread = isRecord(failed.executionThread) ? failed.executionThread : {};
  expect(failed.status).toBe("failed");
  expect(failed.error).toMatchObject({ code: "execution_failed", retryable: false });
  expect(JSON.stringify(failed.error)).toMatch(/temporarily unavailable|503/i);
  expect(typeof failedThread.nativeThreadId).toBe("string");
  expect(typeof failedThread.workspaceId).toBe("string");
  expect(records(failedReceipt.events).map((event) => event.type)).toEqual(["user", "terminal"]);
  evidence.recordAssertionEvidence(
    "A provider outage fails promptly with a linked local execution thread",
    `Run ${failedRunId} received synthetic HTTP 503 responses and reached failed/execution_failed with its native session and workspace preserved; its event sequence ended at terminal instead of remaining running or waiting.`,
    true,
  );

  providerControl.unavailable = false;
  const recoveredRun = await triggerManualRun(den.admin, created.automationId);
  const recoveredRunId = typeof recoveredRun.id === "string" ? recoveredRun.id : "";
  const recoveredReceipt = await waitForTerminalReceipt(den.admin, recoveredRunId);
  const recovered = await assertSucceededReceipt(recoveredReceipt, created);
  expect(recovered.sessionId).not.toBe(failedThread.nativeThreadId);
  evidence.recordAssertionEvidence(
    "A later run succeeds after the provider recovers",
    `Without editing or recreating the Automation, run ${recovered.runId} completed in a new native session after the provider began serving successful responses.`,
    true,
  );
});

test("Desktop runner claims are idempotent and expired leases recover safely", { timeout: 5 * 60_000 }, async ({ evidence, place }) => {
  needs({ optIn: ["SOFIA_EVAL_E2E_TESTS"] });
  const completionBodies: unknown[] = [];
  const providerBaseUrl = await startProviderMock(completionBodies);
  await using den = await server({
    place,
    env: {
      DEN_AUTOMATIONS_LEASE_MS: "2500",
      DEN_AUTOMATIONS_POLL_INTERVAL_MS: "1000",
      DEN_AUTOMATIONS_RUNNER_CLAIM_DEADLINE_MS: "30000",
    },
    org: {
      name: `Automation Lease Recovery ${Date.now()}`,
      admin: { name: "Automation Lease Admin" },
    },
  });
  const orgId = await organizationId(den.admin);
  const providerId = await createProvider(den.admin, orgId, providerBaseUrl, PROVIDER_API_KEY);
  const created = await createAutomation(den.admin, orgId, {
    name: `Synthetic lease recovery ${Date.now()}`,
    instructions: "This synthetic run must never reach a provider.",
    providerId,
  });
  const registration = (runnerId: string) => ({
    runnerId,
    protocolVersion: 1,
    supportedExecutionTargets: ["desktop"],
    capabilities: [AUTOMATION_MODEL_ATTENTION_CAPABILITY],
    appVersion: "automation-reliability-eval",
    platform: "darwin",
    concurrency: 1,
  });
  const mintRunner = async (runnerId: string): Promise<string> => {
    const response = await denFetch(den.admin, "/v1/automation-runners/token", {
      method: "POST",
      headers: auth(den.admin),
      body: JSON.stringify(registration(runnerId)),
    });
    const token = isRecord(response.body) && typeof response.body.token === "string"
      ? response.body.token
      : "";
    expect(response.response.status, response.text).toBe(200);
    expect(token).not.toBe("");
    return token;
  };
  const runnerRequest = (token: string, path: string, options: RequestInit = {}) =>
    denFetch(den.admin, path, {
      ...options,
      headers: { ...options.headers, authorization: `Bearer ${token}` },
    });

  const firstRunnerToken = await mintRunner(`synthetic-runner-primary-${Date.now()}`);
  const secondRunnerToken = await mintRunner(`synthetic-runner-secondary-${Date.now()}`);
  const run = await triggerManualRun(den.admin, created.automationId);
  const runId = typeof run.id === "string" ? run.id : "";
  const work = await runnerRequest(firstRunnerToken, "/v1/automation-runner/work");
  expect(work.response.status, work.text).toBe(200);
  expect(JSON.stringify(work.body)).toContain(runId);

  const firstClaim = await runnerRequest(
    firstRunnerToken,
    `/v1/automation-runs/${encodeURIComponent(runId)}/claim`,
    { method: "POST" },
  );
  const duplicateClaim = await runnerRequest(
    firstRunnerToken,
    `/v1/automation-runs/${encodeURIComponent(runId)}/claim`,
    { method: "POST" },
  );
  expect(firstClaim.response.status, firstClaim.text).toBe(200);
  expect(duplicateClaim.response.status, duplicateClaim.text).toBe(200);
  const firstAssignment = isRecord(firstClaim.body) && isRecord(firstClaim.body.assignment)
    ? firstClaim.body.assignment
    : {};
  const duplicateAssignment = isRecord(duplicateClaim.body) && isRecord(duplicateClaim.body.assignment)
    ? duplicateClaim.body.assignment
    : {};
  expect(firstAssignment).toMatchObject({ runId, attempt: 1 });
  expect(duplicateAssignment).toMatchObject({ runId, attempt: 1 });

  const competingClaim = await runnerRequest(
    secondRunnerToken,
    `/v1/automation-runs/${encodeURIComponent(runId)}/claim`,
    { method: "POST" },
  );
  expect(competingClaim.response.status, competingClaim.text).toBe(200);
  expect(isRecord(competingClaim.body) ? competingClaim.body.assignment : undefined).toBeNull();

  await eventually(async () => {
    const receipt = await denFetch(den.admin, `/v1/automation-runs/${encodeURIComponent(runId)}`, {
      headers: auth(den.admin),
    });
    return isRecord(receipt.body) && isRecord(receipt.body.run) ? receipt.body.run : {};
  }, {
    within: 30_000,
    intervalMs: 250,
    label: "first expired lease requeued for recovery",
    until: (recoveredRun) => recoveredRun.status === "queued" && recoveredRun.attemptCount === 1,
  });

  const recoveryClaim = await runnerRequest(
    firstRunnerToken,
    `/v1/automation-runs/${encodeURIComponent(runId)}/claim`,
    { method: "POST" },
  );
  const recoveryAssignment = isRecord(recoveryClaim.body) && isRecord(recoveryClaim.body.assignment)
    ? recoveryClaim.body.assignment
    : {};
  expect(recoveryClaim.response.status, recoveryClaim.text).toBe(200);
  expect(recoveryAssignment).toMatchObject({ runId, attempt: 2 });

  const staleCompletion = await runnerRequest(
    firstRunnerToken,
    `/v1/automation-runs/${encodeURIComponent(runId)}/complete`,
    {
      method: "POST",
      body: JSON.stringify({
        attempt: 1,
        status: "succeeded",
        sessionId: "stale-session-must-not-win",
        workspaceId: "stale-workspace-must-not-win",
        resultSummary: "stale completion",
        usage: { inputTokens: 1, outputTokens: 1, costMicros: null },
        error: null,
      }),
    },
  );
  expect(staleCompletion.response.status, staleCompletion.text).toBe(409);
  expect(staleCompletion.body).toEqual({ error: "runner_lease_lost" });

  const terminalReceipt = await waitForTerminalReceipt(den.admin, runId);
  const terminalRun = isRecord(terminalReceipt.run) ? terminalReceipt.run : {};
  expect(terminalRun).toMatchObject({
    status: "failed",
    attemptCount: 2,
    error: { code: "lease_lost", retryable: false },
  });
  expect(terminalRun.resultSummary).toBeNull();
  expect(completionBodies).toHaveLength(0);
  evidence.recordAssertionEvidence(
    "Duplicate claims and expired leases cannot duplicate execution or accept stale completion",
    `Runner one received the same attempt-1 assignment twice, runner two could not claim it, the first expiry requeued attempt 1, attempt 2 rejected the stale attempt-1 completion with HTTP 409, and the second expiry ended run ${runId} as failed/lease_lost with no provider request.`,
    true,
  );
});
