/** Read only limits explicitly advertised for this model. An input cap can
 * be smaller than its total context window, so retain the stricter bound. */
export function providerModelContextWindow(value: unknown): number | null {
  if (!isRecord(value)) return null;
  const limit = isRecord(value.limit) ? value.limit : {};
  const candidates = [value.contextWindow, value.context_window, value.context_length,
    value.max_input_tokens, value.maxInputTokens, limit.context, limit.input];
  const limits = candidates.flatMap(candidate => {
    const parsed = typeof candidate === "number" ? candidate : typeof candidate === "string" && candidate.trim() ? Number(candidate) : Number.NaN;
    return Number.isFinite(parsed) && parsed >= 1 ? [Math.floor(parsed)] : [];
  });
  return limits.length ? Math.min(...limits) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
