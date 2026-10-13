import { upsertTopLevelKeys } from "./codex-config.js";

export function applyLocalMemoryToml(
  toml: string,
  settings: { use_memories: boolean; generate_memories: boolean } | undefined,
  selectedModel: string | null,
): string {
  // Leave hand-configured native memory settings intact until the app owns them.
  if (!settings) return toml;
  if (settings.generate_memories && !selectedModel) {
    throw new Error("Choose a provider model before enabling local memory generation.");
  }
  const next = upsertTopLevelKeys(toml, "features", [
    `memories = ${settings.use_memories || settings.generate_memories}`,
  ]);
  return upsertTopLevelKeys(next, "memories", [
    `use_memories = ${settings.use_memories}`,
    `generate_memories = ${settings.generate_memories}`,
    // Both jobs use the configured provider's model, including custom providers.
    ...(selectedModel ? [
      `extract_model = ${JSON.stringify(selectedModel)}`,
      `consolidation_model = ${JSON.stringify(selectedModel)}`,
    ] : []),
  ]);
}
