export type ComposerSubmitAction = "send" | "steer" | "queue";

export function resolveSubmitAction(input: { busy: boolean; modifier: boolean; mode?: "queue" | "steer" }): ComposerSubmitAction {
  if (!input.busy) return "send";
  const preferred = input.mode ?? "steer";
  return input.modifier ? (preferred === "queue" ? "steer" : "queue") : preferred;
}
