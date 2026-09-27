import { describe, expect, test } from "bun:test";
import type { DynamicToolUIPart } from "ai";

import { getAggregateSummary, getToolFamily, isAggregatableToolPart } from "../src/lib/tool-aggregate";
import { codexItemToToolPart } from "../src/react-app/domains/session/sync/codex-item-translator";

function command(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "cmd-1",
    type: "commandExecution",
    command: "/bin/zsh -lc 'rg -n phase apps/app/src'",
    source: "unifiedExecStartup",
    status: "completed",
    exitCode: 0,
    aggregatedOutput: "apps/app/src/x.ts:12",
    ...overrides,
  };
}

const part = (item: Record<string, unknown>) =>
  codexItemToToolPart(item, "session", "message", true) as unknown as DynamicToolUIPart;

/** Only a settled item is passed as completed; a running one is not. */
const runningPart = (item: Record<string, unknown>) =>
  codexItemToToolPart(item, "session", "message", false) as unknown as DynamicToolUIPart;

/**
 * Regression: unified exec reports *every* command through its startup event, so
 * the translator's `source === "unifiedExecStartup"` test labelled every finished
 * command a `background_process`. The renderer hides those outside developer
 * mode, so 856 finished commands in one real session rendered as nothing — and
 * each invisible row still paid the work block's row gap, which is what turned
 * the narrative into commentary prose separated by voids, with no tool
 * milestones anywhere.
 */
describe("a finished unified-exec command is a shell call, not a background process", () => {
  test("it stays a shell command the aggregator can collapse", () => {
    const finished = part(command({}));

    expect(finished.toolName).toBe("bash");
    expect(getToolFamily(finished)).toBe("command");
    expect(isAggregatableToolPart(finished)).toBe(true);
    expect(getAggregateSummary([finished, part(command({ id: "cmd-2" }))], "past")).toBe(
      "Ran 2 commands",
    );
  });

  test("a failed command is still shown, not hidden as background activity", () => {
    const failedPart = part(command({ id: "cmd-3", status: "failed", exitCode: 1 }));

    expect(failedPart.toolName).toBe("bash");
    expect(failedPart.state).toBe("output-error");
  });

  test("a command that is still running stays a background process", () => {
    const running = runningPart(command({ id: "cmd-4", status: "inProgress", exitCode: null }));

    expect(running.toolName).toBe("background_process");
    expect(getToolFamily(running)).toBeNull();
  });
});
