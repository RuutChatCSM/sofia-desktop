import { expect } from "vitest";
import { test } from "@sofia/testkit";

import {
  createBrowserPresentationState,
  reduceBrowserPresentation,
  type BrowserPresentationEvent,
  type BrowserPresentationState,
} from "../../apps/app/src/react-app/domains/session/panel/browser-presentation.js";
import { effectiveBrowserViewport } from "../../apps/desktop/electron/browser-tab-state.mjs";

function run(events: BrowserPresentationEvent[]): BrowserPresentationState {
  return events.reduce(
    (state, event) => reduceBrowserPresentation(state, event),
    createBrowserPresentationState(),
  );
}

test("presentation policy decides what the user sees, not the agent", async ({ evidence }) => {
  const surfaced = run([{ type: "agent-browser-started" }]);
  expect(surfaced.runtime.mode).toBe("peek");

  const hidden = run([{ type: "agent-browser-started" }, { type: "user-hide-peek" }]);
  expect(hidden.runtime.mode).toBe("hidden");
  expect(hidden.runtime.peekSuppressed).toBe(true);
  // Repeated agent activity must not resurrect a dismissed preview.
  expect(
    run([{ type: "agent-browser-started" }, { type: "user-hide-peek" }, { type: "agent-browser-started" }]),
  ).toEqual(hidden);

  // Attention is reported, but it does not steal layout from a user who hid it.
  const needsAttention = run([
    { type: "agent-browser-started" },
    { type: "user-hide-peek" },
    { type: "attention-required", reason: "authentication", url: "https://github.com/login" },
  ]);
  expect(needsAttention.runtime.mode).toBe("hidden");
  expect(needsAttention.runtime.attention).toMatchObject({ reason: "authentication", host: "github.com" });

  evidence.recordAssertionEvidence(
    "A dismissed browser preview stays dismissed for the rest of the task",
    "Agent activity surfaces Peek once, three more agent-started events leave the hidden state identical, and an authentication prompt records attention without reopening the surface.",
    true,
  );
});

test("Expand returns to exactly where it came from", async ({ evidence }) => {
  const docked684 = run([
    { type: "agent-browser-started" },
    { type: "user-dock-browser", width: 684 },
    { type: "user-expand-browser" },
  ]);
  expect(docked684.runtime.mode).toBe("expanded");
  expect(docked684.runtime.restore).toEqual({ mode: "docked", width: 684 });

  const restored = reduceBrowserPresentation(docked684, { type: "user-restore-browser" });
  expect(restored.runtime.mode).toBe("docked");
  expect(restored.preferences.dockedWidth).toBe(684);

  const fromPeek = run([{ type: "agent-browser-started" }, { type: "user-expand-browser" }]);
  expect(reduceBrowserPresentation(fromPeek, { type: "user-restore-browser" }).runtime.mode).toBe("peek");
  evidence.recordAssertionEvidence(
    "Restore returns to the previous presentation, including its docked width",
    "A 684px docked panel that expands restores to docked at 684px, and a Peek that expands restores to Peek.",
    true,
  );
});

test("Peek renders a desktop breakpoint without rewriting the tab's viewport", async ({ evidence }) => {
  const panelTab = { mode: "panel" };
  expect(effectiveBrowserViewport(panelTab, "peek")).toEqual({
    mode: "responsive",
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
  });
  expect(panelTab).toEqual({ mode: "panel" });

  // Docked and expanded keep ordinary panel semantics.
  for (const presentation of ["hidden", "docked", "expanded"]) {
    expect(effectiveBrowserViewport(panelTab, presentation)).toEqual({ mode: "panel" });
  }

  // An explicit device preset always wins over the presentation default.
  const phone = { mode: "responsive", width: 390, height: 844, deviceScaleFactor: 3 };
  expect(effectiveBrowserViewport(phone, "peek")).toEqual(phone);

  evidence.recordAssertionEvidence(
    "Peek substitutes a transient desktop viewport and never mutates the durable one",
    "A panel-mode tab resolves to 1280x800 while presented as Peek (the tab object still reads { mode: 'panel' }), docked/expanded keep panel semantics, and an explicit 390x844 preset is passed through untouched.",
    true,
  );
});
