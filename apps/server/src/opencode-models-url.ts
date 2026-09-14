import { loopbackFetch } from "./server-fetch.js";

const LOCAL_MODELS_URL = "http://localhost:8791/models";
// The canonical models.dev catalog. The previous OpenWork-hosted snapshot
// (models.openworklabs.com) lagged upstream — e.g. its DeepSeek entry had 3
// models with no V4.1 (`deepseek-flash`). models.dev is the superset the Sofia
// engine uses, so point the runtime catalog at it directly.
const PRODUCTION_MODELS_URL = "https://models.dev";

type ResolveOpencodeModelsUrlOptions = {
  env?: NodeJS.ProcessEnv;
  fetchModels?: (input: string, init?: RequestInit) => Promise<{ ok: boolean }>;
};

export async function resolveOpencodeModelsUrl(
  options: ResolveOpencodeModelsUrlOptions = {},
): Promise<string> {
  const env = options.env ?? process.env;
  const override = env.OPENCODE_MODELS_URL?.trim();
  if (override) return override;
  if (env.OPENWORK_DEV_MODE !== "1") return PRODUCTION_MODELS_URL;

  try {
    const response = await (options.fetchModels ?? loopbackFetch)(`${LOCAL_MODELS_URL}/api.json`, {
      signal: AbortSignal.timeout(1_000),
    });
    if (response.ok) return LOCAL_MODELS_URL;
  } catch {
    // A standalone desktop dev session does not run the local inference stack.
  }

  return PRODUCTION_MODELS_URL;
}
