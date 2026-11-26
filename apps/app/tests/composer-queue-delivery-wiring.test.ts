import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const surface = readFileSync(
  new URL("../src/react-app/domains/session/surface/session-surface.tsx", import.meta.url),
  "utf8",
);

describe("session composer queue delivery wiring", () => {
  test("a delivery error cannot fail the session transition that disables the composer", () => {
    expect(surface).toContain("deriveComposerAvailability({");
    expect(surface).toContain("snapshotError: snapshotQuery.isError,");
    expect(surface).toContain("deliveryError: Boolean(error),");
    expect(surface).toContain("disabled={composerDisabled}");
    expect(surface).not.toContain("isError: snapshotQuery.isError || Boolean(error)");
  });

  test("delete, successful retry, and echo settlement release the queue admission", () => {
    expect(surface).toContain('resolveQueuedDelivery(target?.deliveryState, "delete")');
    expect(surface).toContain('resolveQueuedDelivery(item.deliveryState, "sent")');
    expect(surface).toContain('resolveQueuedDelivery(item?.deliveryState, "echo")');
    expect(surface).toContain("if (resolution.releaseAdmission) queueAdmission.current.retry(props.sessionId);");
    expect(surface).toContain("if (releaseAdmission) queueAdmission.current.retry(props.sessionId);");
  });
});
