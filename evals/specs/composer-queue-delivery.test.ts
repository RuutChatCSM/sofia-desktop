import { expect } from "vitest";
import { test } from "@sofia/testkit";
import type { ComposerDraft } from "../../apps/app/src/app/types";
import type { QueuedComposerItem } from "../../apps/app/src/react-app/domains/session/surface/composer-state-store";
import { ComposerQueueAdmission } from "../../apps/app/src/react-app/domains/session/surface/composer-queue-admission";
import { deliveredQueuedDraftIds, queuedDraftSentText, resolveQueuedDelivery, type QueuedDeliveryAction } from "../../apps/app/src/react-app/domains/session/surface/composer-queue-delivery";

function draft(text: string, resolvedText = text): ComposerDraft {
  return { mode: "prompt", parts: [{ type: "text", text }], attachments: [], text, resolvedText };
}

function item(id: string, deliveryState: QueuedComposerItem["deliveryState"], value: ComposerDraft): QueuedComposerItem {
  return { id, draft: value, deliveryState };
}

test("an unconfirmed queued send resolves once the engine echoes the same text", () => {
  const items = [item("uncertain", "outcome-unknown", draft("Review queued.txt"))];
  expect(deliveredQueuedDraftIds(items, [])).toEqual([]);
  expect(deliveredQueuedDraftIds(items, ["Unrelated turn", "Review queued.txt"])).toEqual(["uncertain"]);
});

test("attachment placeholders resolve to the prompt text the engine echoes", () => {
  const queued = draft("Review this [attachment att-1]", "Review this ");
  expect(queuedDraftSentText(queued)).toBe("Review this");
  expect(deliveredQueuedDraftIds([item("uncertain", "outcome-unknown", queued)], ["Review this"])).toEqual(["uncertain"]);
});

test("only outcome-unknown items settle from an echo, so a ready item is never silently dropped", () => {
  const ready = item("ready", "ready", draft("Same prompt"));
  const sending = item("sending", "sending", draft("Same prompt"));
  expect(deliveredQueuedDraftIds([ready, sending], ["Same prompt"])).toEqual([]);
});

test("an image-only unconfirmed send is not matched by an empty echo", () => {
  const queued = draft("", "");
  expect(queuedDraftSentText(queued)).toBe("");
  expect(deliveredQueuedDraftIds([item("uncertain", "outcome-unknown", queued)], ["", "  "])).toEqual([]);
});

test("an unknown delivery keeps the queue admission blocked until a settling action releases it", () => {
  const admission = new ComposerQueueAdmission();
  admission.begin("session");
  admission.defer("session");
  admission.settle("session");
  expect(admission.canSend("session")).toBe(false);

  const failedRetry = resolveQueuedDelivery("outcome-unknown", "retry-failed");
  expect(failedRetry).toEqual({ removeItem: false, releaseAdmission: false });
  expect(admission.canSend("session")).toBe(false);

  const deletion = resolveQueuedDelivery("outcome-unknown", "delete");
  expect(deletion).toEqual({ removeItem: true, releaseAdmission: true });
  if (deletion.releaseAdmission) admission.retry("session");
  expect(admission.canSend("session")).toBe(true);
});

test("a successful retry or an engine echo also releases the blocked admission", () => {
  const settlingActions: QueuedDeliveryAction[] = ["sent", "echo"];
  for (const action of settlingActions) {
    const admission = new ComposerQueueAdmission();
    admission.begin("session");
    admission.defer("session");
    admission.settle("session");
    const resolution = resolveQueuedDelivery("outcome-unknown", action);
    expect(resolution.removeItem).toBe(true);
    if (resolution.releaseAdmission) admission.retry("session");
    expect(admission.canSend("session")).toBe(true);
  }
});
