import { expect } from "vitest";
import { control, createAndSelectWorkspace, evalIn, waitFor } from "@sofia/behaviors";
import { desktop } from "@sofia/hosts";
import { needs, test } from "@sofia/testkit";

test("accepted new task appears in sidebar before background polling", { timeout: 180_000 }, async () => {
  needs({ optIn: ["SOFIA_EVAL_E2E_TESTS"], placement: "local" });
  await using app = await desktop({ name: "sidebar-session-create" });
  await createAndSelectWorkspace(app, { path: `/tmp/sofia-sidebar-create-${Date.now()}` });
  await waitFor(app, "Boolean(window.__sofiaControl?.listActions?.().some(action => action.id === 'session.create_task' && action.disabled === false))", { label: "selected workspace session creation ready", timeoutMs: 60_000 });
  const id = await control(app, "session.create_task", undefined, { timeoutMs: 60_000 });
  if (typeof id !== "string" || !id) throw new Error(`Task creation did not return an ID: ${JSON.stringify(id)}`);
  await waitFor(app, `Boolean(document.querySelector('[data-sidebar-session-id="${id}"]'))`, { label: "created task visible before 30 second polling", timeoutMs: 5_000 });
  expect(await evalIn(app, `document.querySelectorAll('[data-sidebar-session-id="${id}"]').length`)).toBe(1);
  // No prompt is sent: thread creation exercises only the local engine/server.
});
