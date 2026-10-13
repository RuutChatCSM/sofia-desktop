/** @jsxImportSource react */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { BackgroundProcess } from "../src/app/lib/codex-session";
import { deriveActivities } from "../src/react-app/domains/session/activity";
import { ActivityStrip, type ActivityStripProps } from "../src/react-app/domains/session/surface/activity-status";

const sessionId = "codex-1";

const devServer: BackgroundProcess = {
  itemId: "call-1",
  processId: "proc-1",
  command: "pnpm --filter @sofia/app dev",
  cwd: "/repo/sofia-app",
  status: "running",
  aggregatedOutput: "ready in 320ms",
};

function render(overrides: Partial<ActivityStripProps> = {}) {
  const processes = overrides.processes ?? [devServer];
  const props: ActivityStripProps = {
    activities: deriveActivities(sessionId, processes),
    processes,
    turnActive: false,
    expanded: false,
    busyId: null,
    stoppingAll: false,
    onToggle: () => undefined,
    onStop: () => undefined,
    onStopAll: () => undefined,
    ...overrides,
  };
  return renderToStaticMarkup(<ActivityStrip {...props} />);
}

describe("composer activity strip", () => {
  test("a live process raises a collapsed strip, named by the operation", () => {
    const markup = render();
    expect(markup).toContain('data-testid="activity-status"');
    // The operation, not the command line.
    expect(markup).toContain("Running the dev server");
    expect(markup).toContain("ow-text-shimmer");
    // Collapsed by default: the terminal is a detail, not the header.
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain("background-process-row");
    expect(markup).not.toContain("pnpm --filter @sofia/app dev");
  });

  test("history and in-flight turns keep the composer bare", () => {
    expect(render({ processes: [], activities: [] })).toBe("");
    // A completed or failed process is history, never a chip.
    expect(render({ processes: [{ ...devServer, status: "failed", exitCode: 1 }] })).toBe("");
    expect(render({ processes: [{ ...devServer, status: "completed", exitCode: 1 }] })).toBe("");
    // While a turn streams the transcript already carries the activity.
    expect(render({ turnActive: true })).toBe("");
  });

  test("expanding names the operation, shows the terminal, and offers Stop", () => {
    const markup = render({ expanded: true });
    expect(markup).toContain('data-testid="background-process-row"');
    expect(markup).toContain("Running the dev server");
    expect(markup).toContain("pnpm --filter @sofia/app dev");
    expect(markup).toContain("/repo/sofia-app");
    expect(markup).toContain("ready in 320ms");
    expect(markup).toContain("Stop");
    // One process already has its own Stop; "Stop all" is for several.
    expect(markup).not.toContain("Stop all");
  });

  test("several live processes collapse to a count and offer Stop all", () => {
    const second: BackgroundProcess = { ...devServer, itemId: "call-2", processId: "proc-2", command: "cargo watch -x test" };
    const markup = render({ processes: [devServer, second], expanded: true });
    expect(markup).toContain("+1");
    expect(markup).toContain("Stop all");
    expect(markup.match(/data-testid="background-process-row"/g)).toHaveLength(2);
  });
});
