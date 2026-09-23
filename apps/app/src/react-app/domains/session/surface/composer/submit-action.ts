// Decide what a composer submit does. Extracted from the React composer so the
// interaction contract is unit-testable: while the agent is idle, submit sends;
// while it is busy, a plain submit QUEUES (a pending row above the composer)
// and only the explicit modifier (Cmd/Ctrl+Enter) steers the active turn.
export type ComposerSubmitAction = "send" | "steer" | "queue";

export function resolveSubmitAction(input: { busy: boolean; modifier: boolean }): ComposerSubmitAction {
  if (!input.busy) return "send";
  return input.modifier ? "steer" : "queue";
}
