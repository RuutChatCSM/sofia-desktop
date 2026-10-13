/** @jsxImportSource react */
import { useCallback, useEffect, useState } from "react";

import type { EngineFeatureInfo } from "@/app/lib/sofia-server";

export type EngineFeaturesClient = {
  getEngineFeatures: () => Promise<{ features: EngineFeatureInfo[] }>;
  patchEngineFeatures: (
    engineFeatures: Record<string, boolean>,
  ) => Promise<{ ok: boolean; changed: boolean; features: EngineFeatureInfo[]; reload: string }>;
};

/**
 * Engine feature flags, owned by the server.
 *
 * Optimistic on purpose: the write goes through an engine reload, so waiting for
 * the response leaves the switch feeling dead. A failed write restores the value
 * the server last reported rather than leaving the UI lying about engine state.
 */
export function useEngineFeatures(client: EngineFeaturesClient | null | undefined) {
  const [features, setFeatures] = useState<EngineFeatureInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!client) return;
    setLoading(true);
    setError(null);
    try {
      const result = await client.getEngineFeatures();
      setFeatures(result.features);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const setEnabled = useCallback(
    async (key: string, enabled: boolean) => {
      if (!client) return;
      const previous = features;
      setBusy(true);
      setError(null);
      setFeatures((current) =>
        current.map((feature) => (feature.key === key ? { ...feature, enabled } : feature)),
      );
      try {
        const result = await client.patchEngineFeatures({ [key]: enabled });
        // Trust the server's resolved state: it applies defaults and refuses
        // removed flags, so echoing our optimistic value could be wrong.
        setFeatures(result.features);
      } catch (cause) {
        setFeatures(previous);
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    },
    [client, features],
  );

  return { features, loading, busy, error, refresh, setEnabled };
}
