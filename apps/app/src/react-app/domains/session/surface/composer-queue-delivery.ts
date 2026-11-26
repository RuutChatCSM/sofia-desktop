import { sanitizePromptText } from "@/lib/embedded-data-urls";
import type { ComposerDraft } from "@/app/types";
import type { QueuedComposerItem } from "./composer-state-store";

/** The prompt text the engine echoes after a queued draft is delivered. */
export function queuedDraftSentText(draft: ComposerDraft): string {
  return sanitizePromptText(draft.resolvedText ?? draft.text).replace(/\[attachment [^\]]+\]/g, "").trim();
}

/**
 * Queued deliveries whose text already appears as an engine user echo. Only
 * outcome-unknown items are considered: a ready item has not been dispatched,
 * so an older identical prompt cannot settle it.
 */
export function deliveredQueuedDraftIds(
  items: readonly QueuedComposerItem[],
  echoedUserTexts: readonly string[],
): string[] {
  const echoed = new Set(echoedUserTexts.map((text) => text.trim()).filter(Boolean));
  if (echoed.size === 0) return [];
  return items.flatMap((item) => {
    if (item.deliveryState !== "outcome-unknown") return [];
    const sentText = queuedDraftSentText(item.draft);
    return sentText && echoed.has(sentText) ? [item.id] : [];
  });
}

export type QueuedDeliveryAction = "sent" | "retry-failed" | "delete" | "echo";

export type QueuedDeliveryResolution = {
  removeItem: boolean;
  releaseAdmission: boolean;
};

/**
 * The queue admission lock is per session, so a settlement action on an
 * unconfirmed item has to release it or every later ready item is stranded.
 * A failed retry leaves the item uncertain and the lock in place.
 */
export function resolveQueuedDelivery(
  deliveryState: QueuedComposerItem["deliveryState"],
  action: QueuedDeliveryAction,
): QueuedDeliveryResolution {
  const uncertain = deliveryState === "outcome-unknown";
  if (action === "sent") return { removeItem: true, releaseAdmission: true };
  if (action === "delete") return { removeItem: true, releaseAdmission: uncertain };
  if (action === "echo") return { removeItem: uncertain, releaseAdmission: uncertain };
  return { removeItem: false, releaseAdmission: false };
}
