import { expect } from "vitest";
import { test } from "@sofia/testkit";
import { ComposerQueueAdmission } from "../../apps/app/src/react-app/domains/session/surface/composer-queue-admission";

test("queue admission retains pending-start protection independently for each conversation", () => {
  const admission = new ComposerQueueAdmission();
  expect(admission.begin("A")).toBe(true);
  admission.settle("A");
  expect(admission.canSend("A")).toBe(false);
  expect(admission.begin("B")).toBe(true);
  admission.observeRun("B");
  admission.settle("B");
  expect(admission.canSend("B")).toBe(true);
  expect(admission.canSend("A")).toBe(false);
  admission.observeRun("A");
  expect(admission.canSend("A")).toBe(true);
});

test("a fast run observed before send settlement releases the next queued draft after settlement", () => {
  const admission = new ComposerQueueAdmission();
  expect(admission.begin("A")).toBe(true);
  admission.observeRun("A");
  expect(admission.begin("A")).toBe(false);
  admission.settle("A");
  expect(admission.begin("A")).toBe(true);
});

test("failed or deferred sends retain drafts without automatic retry loops and can be explicitly retried", () => {
  const admission = new ComposerQueueAdmission();
  admission.begin("A");
  admission.defer("A");
  admission.settle("A");
  expect(admission.canSend("A")).toBe(false);
  expect(admission.canSend("B")).toBe(true);
  admission.retry("A");
  expect(admission.begin("A")).toBe(true);
});
