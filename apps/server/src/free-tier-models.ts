// Model list for the free tier.
//
// Three inputs decide what the engine sees:
//   1. the cloud allowlist — which models we are willing to expose at all
//   2. the upstream catalog — which of them still exist right now
//   3. this client's recent failures — which of them are currently refusing work
//
// (1) is authoritative because the upstream does not publish free-tier status
// and retention policy differs per model: a model appearing in their catalog is
// not consent to send Sofia users' files to it. (2) and (3) are hygiene — a
// withdrawn or 429-ing model should disappear from the picker without a deploy.
import type { FreeTierConfig, FreeTierModel } from "./free-tier-config.js";

const CATALOG_TIMEOUT_MS = 4_000;
/** A model that just 429/5xx'd is hidden for this long. */
const UNAVAILABLE_TTL_MS = 5 * 60_000;

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export type FreeTierModelList = {
  models: FreeTierModel[];
  source: "allowlist" | "upstream" | "cached";
  error?: string;
  /** Allowlist entries the upstream catalog no longer offers. */
  withdrawn: string[];
};

type CatalogCache = {
  ids: Set<string>;
  expiresAt: number;
};

type Unavailable = Map<string, number>;

export type FreeTierModelRegistry = {
  list: () => Promise<FreeTierModelList>;
  markUnavailable: (modelId: string) => void;
  reset: () => void;
};

function isModelId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function upstreamIds(payload: unknown): Set<string> | null {
  if (typeof payload !== "object" || payload === null) return null;
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return null;
  const ids = new Set<string>();
  for (const entry of data) {
    if (typeof entry === "object" && entry !== null && isModelId((entry as { id?: unknown }).id)) {
      ids.add((entry as { id: string }).id);
    }
  }
  return ids;
}

export function createFreeTierModelRegistry(options: {
  config: FreeTierConfig;
  fetcher: Fetcher;
  now?: () => number;
}): FreeTierModelRegistry {
  const now = options.now ?? Date.now;
  const discovery = options.config.discovery;
  let catalog: CatalogCache | null = null;
  let lastError: string | undefined;
  const unavailable: Unavailable = new Map();

  async function readCatalog(): Promise<Set<string> | null> {
    if (!discovery) return null;
    if (catalog && catalog.expiresAt > now()) return catalog.ids;
    try {
      const response = await options.fetcher(discovery.modelsUrl, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`models returned ${response.status}`);
      const ids = upstreamIds(await response.json());
      if (!ids) throw new Error("models payload had no data array");
      catalog = { ids, expiresAt: now() + discovery.ttlSeconds * 1_000 };
      lastError = undefined;
      return ids;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      // Keep serving the previous catalog if we have one; a stale catalog is
      // still better than hiding every model on a transient failure.
      return catalog?.ids ?? null;
    }
  }

  function withoutFailures(models: FreeTierModel[]): FreeTierModel[] {
    const timestamp = now();
    return models.filter((model) => {
      const until = unavailable.get(model.id);
      if (until === undefined) return true;
      if (until > timestamp) return false;
      unavailable.delete(model.id);
      return true;
    });
  }

  async function list(): Promise<FreeTierModelList> {
    const allowlist = options.config.models;
    if (!discovery || discovery.mode === "off") {
      return { models: withoutFailures(allowlist), source: "allowlist", withdrawn: [] };
    }

    const ids = await readCatalog();
    if (!ids) {
      // Upstream catalog unreachable: trust the allowlist rather than shipping
      // an empty model picker.
      return {
        models: withoutFailures(allowlist),
        source: catalog ? "cached" : "allowlist",
        withdrawn: [],
        ...(lastError ? { error: lastError } : {}),
      };
    }

    if (discovery.mode === "replace") {
      const pattern = new RegExp(discovery.freeIdPattern);
      const known = new Map(allowlist.map((model) => [model.id, model]));
      const models: FreeTierModel[] = [];
      for (const id of ids) {
        if (!pattern.test(id) && !discovery.extraFreeIds.includes(id)) continue;
        models.push(known.get(id) ?? { id });
      }
      return {
        models: withoutFailures(models),
        source: "upstream",
        withdrawn: [],
        ...(lastError ? { error: lastError } : {}),
      };
    }

    // intersect: keep allowlist order and metadata, drop what is gone.
    const kept = allowlist.filter((model) => ids.has(model.id));
    const withdrawn = allowlist.filter((model) => !ids.has(model.id)).map((model) => model.id);
    return {
      models: withoutFailures(kept),
      source: "upstream",
      withdrawn,
      ...(lastError ? { error: lastError } : {}),
    };
  }

  return {
    list,
    markUnavailable(modelId) {
      unavailable.set(modelId, now() + UNAVAILABLE_TTL_MS);
    },
    reset() {
      catalog = null;
      unavailable.clear();
      lastError = undefined;
    },
  };
}
