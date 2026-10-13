// model-catalog.json — the `model_catalog_json` the app hands the engine.
//
// The engine's vendored catalog only describes OpenAI-era models. Anything else
// (BYOK, models.dev, a self-hosted endpoint) resolves through the engine's
// `model_info_from_slug` fallback, which is built for an unknown chat model. That
// fallback is what cost us the file-editing tool and the real context window, so
// the app ships the models the user actually connected.
//
// Additive by contract: the engine merges this over its bundled catalog (see
// `merge_with_bundled_catalog`), so only the models the app knows need to appear
// here and a built-in model never loses its richer metadata.
import { providerModelContextWindow } from "./codex-model-limits.js";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const CODEX_MODEL_CATALOG_FILE = "model-catalog.json";

export type CodexCatalogModel = {
  id: string;
  name: string;
  /** models.dev `reasoning`; drives whether we advertise reasoning presets. */
  reasoning?: boolean;
  /** models.dev `limit.context`, also written top-level for auto-compaction. */
  contextWindow?: number | null;
};

/**
 * The engine's `ModelInfo` wire shape (`sofia_protocol::openai_models::ModelInfo`).
 *
 * Every field is emitted, including nulls, because several have no serde default
 * and a missing field fails the whole catalog load at startup.
 */
export type CodexCatalogModelInfo = {
  slug: string;
  display_name: string;
  description: string | null;
  default_reasoning_level: string | null;
  supported_reasoning_levels: Array<{ effort: string; description: string }>;
  shell_type: string;
  visibility: string;
  supported_in_api: boolean;
  priority: number;
  additional_speed_tiers: string[];
  service_tiers: string[];
  default_service_tier: string | null;
  availability_nux: null;
  upgrade: null;
  model_messages: null;
  include_skills_usage_instructions: boolean;
  include_plugin_usage_instructions: boolean;
  include_apps_usage_instructions: boolean;
  supports_reasoning_summary_parameter: boolean;
  default_reasoning_summary: string;
  support_verbosity: boolean;
  default_verbosity: string | null;
  apply_patch_tool_type: string | null;
  web_search_tool_type: string;
  truncation_policy: { mode: string; limit: number };
  supports_image_detail_original: boolean;
  context_window: number | null;
  max_context_window: number | null;
  auto_compact_token_limit: number | null;
  comp_hash: null;
  effective_context_window_percent: number;
  experimental_supported_tools: string[];
  input_modalities: string[];
  supports_search_tool: boolean;
  supports_experimental_context: boolean;
  use_responses_lite: boolean;
  node_repl_auto_review_required: boolean;
  node_repl_disabled: boolean;
  auto_review_model_override: string | null;
  model_specialty: string | null;
};

export function buildCodexCatalogModelInfo(model: CodexCatalogModel): CodexCatalogModelInfo {
  const contextWindow =
    typeof model.contextWindow === "number" && model.contextWindow > 0 ? model.contextWindow : null;

  return {
    slug: model.id,
    display_name: model.name,
    description: null,
    default_reasoning_level: null,
    supported_reasoning_levels: [],
    shell_type: "unified_exec",
    // `list` keeps the model selectable; `none` would hide it from every picker.
    visibility: "list",
    supported_in_api: true,
    priority: 0,
    additional_speed_tiers: [],
    service_tiers: [],
    default_service_tier: null,
    availability_nux: null,
    upgrade: null,
    // Left null so the engine backfills its own base instructions for the slug
    // instead of us shipping a divergent prompt.
    model_messages: null,
    include_skills_usage_instructions: false,
    include_plugin_usage_instructions: false,
    include_apps_usage_instructions: true,
    supports_reasoning_summary_parameter: true,
    default_reasoning_summary: "auto",
    support_verbosity: false,
    default_verbosity: null,
    // The one field that decides whether the agent can edit files. A connected
    // chat model with tool calling can always host the patch tool; the engine and
    // the app both keep their own ways to deny it.
    apply_patch_tool_type: "freeform",
    web_search_tool_type: "text",
    truncation_policy: { mode: "tokens", limit: 10_000 },
    supports_image_detail_original: false,
    context_window: contextWindow,
    max_context_window: contextWindow,
    // Omitted so the engine derives it from `context_window` (90%).
    auto_compact_token_limit: null,
    comp_hash: null,
    effective_context_window_percent: 95,
    experimental_supported_tools: [],
    // The engine's own default for an unannotated model.
    input_modalities: ["text", "image"],
    supports_search_tool: false,
    supports_experimental_context: false,
    use_responses_lite: false,
    node_repl_auto_review_required: false,
    node_repl_disabled: false,
    auto_review_model_override: null,
    model_specialty: null,
  };
}

/** Build the `{ models: [...] }` payload, de-duplicated by slug (first wins). */
export function buildCodexModelCatalog(models: readonly CodexCatalogModel[]): {
  models: CodexCatalogModelInfo[];
} {
  const seen = new Set<string>();
  const entries: CodexCatalogModelInfo[] = [];
  for (const model of models) {
    if (!model.id || seen.has(model.id)) continue;
    seen.add(model.id);
    entries.push(buildCodexCatalogModelInfo(model));
  }
  return { models: entries };
}

export function codexModelCatalogJson(models: readonly CodexCatalogModel[]): string {
  return `${JSON.stringify(buildCodexModelCatalog(models), null, 2)}\n`;
}

export async function writeCodexModelCatalog(
  path: string,
  models: readonly CodexCatalogModel[],
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, codexModelCatalogJson(models), "utf8");
}

/** Every model the app has connected, across providers. */
export function codexCatalogModelsFromProviders(
  providers: readonly { models: readonly CodexCatalogModel[] }[],
): CodexCatalogModel[] {
  return providers.flatMap((provider) => provider.models.map((model) => ({ ...model })));
}

/** Keep connected model identities while filling missing limits from runtime metadata. */
export function mergeCodexCatalogModels(
  connected: readonly CodexCatalogModel[],
  runtime: readonly CodexCatalogModel[],
): CodexCatalogModel[] {
  const models = new Map<string, CodexCatalogModel>();
  for (const model of [...connected, ...runtime]) {
    const existing = models.get(model.id);
    if (!existing) {
      models.set(model.id, { ...model });
    } else if (!(typeof existing.contextWindow === "number" && existing.contextWindow > 0)
      && typeof model.contextWindow === "number" && model.contextWindow > 0) {
      models.set(model.id, { ...existing, contextWindow: model.contextWindow });
    }
  }
  return [...models.values()];
}

/**
 * Models from the raw runtime provider map (the Den / Sofia Cloud shape):
 * `{ <providerId>: { models: { <modelId>: { name, limit: { context } } } } }`.
 *
 * Defensive by design — this is engine input, so a missing or unexpected field
 * must narrow the catalog, never fail config generation.
 */
export function codexCatalogModelsFromRuntimeProviderMap(
  providerMap: Record<string, Record<string, unknown>>,
): CodexCatalogModel[] {
  const models: CodexCatalogModel[] = [];
  for (const value of Object.values(providerMap)) {
    const rawModels = value?.models;
    if (!rawModels || typeof rawModels !== "object" || Array.isArray(rawModels)) continue;
    for (const [modelId, rawModel] of Object.entries(rawModels as Record<string, unknown>)) {
      if (!modelId.trim()) continue;
      const model = rawModel && typeof rawModel === "object" && !Array.isArray(rawModel)
        ? (rawModel as Record<string, unknown>)
        : {};
      const name = typeof model.name === "string" && model.name.trim() ? model.name.trim() : modelId;
      const context = providerModelContextWindow(model);
      models.push({
        id: modelId,
        name,
        contextWindow: context,
      });
    }
  }
  return models;
}
