import { expect } from "vitest";
import { test } from "@sofia/testkit";
import { deriveComposerAvailability, type ComposerAvailabilityInput } from "../../apps/app/src/react-app/domains/session/sync/transition-controller";

function input(overrides: Partial<ComposerAvailabilityInput> = {}): ComposerAvailabilityInput {
  return {
    intendedSessionId: "codex-1",
    renderedSessionId: "codex-1",
    hasSnapshot: true,
    isFetching: false,
    snapshotError: false,
    deliveryError: false,
    modelUnavailable: false,
    ...overrides,
  };
}

test("a failed queued delivery does not fail the session transition or disable the composer", () => {
  const availability = deriveComposerAvailability(input({ deliveryError: true }));
  expect(availability.model.transitionState).toBe("idle");
  expect(availability.disabled).toBe(false);
});

test("a transcript load failure still fails the transition and disables the composer", () => {
  const availability = deriveComposerAvailability(input({ snapshotError: true }));
  expect(availability.model.transitionState).toBe("failed");
  expect(availability.disabled).toBe(true);
});

test("an unavailable model disables the composer without failing the session transition", () => {
  const availability = deriveComposerAvailability(input({ modelUnavailable: true }));
  expect(availability.model.transitionState).toBe("idle");
  expect(availability.disabled).toBe(true);
});
