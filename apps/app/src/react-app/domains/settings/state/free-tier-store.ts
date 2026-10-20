/** @jsxImportSource react */
import { useCallback, useEffect, useState } from "react";

import type { SofiaFreeTierStatus } from "@/app/lib/sofia-server";

export type FreeTierClient = {
  getFreeTierStatus: () => Promise<SofiaFreeTierStatus>;
  setFreeTierEnabled: (
    enabled: boolean,
  ) => Promise<{ ok: boolean; changed: boolean; enabled: boolean; reload: string }>;
};

/**
 * Sofia Free provider state.
 *
 * The server owns the contract (fingerprint, allowlist, upstream reconciliation)
 * and rewrites the engine's provider entry when toggled, so this hook only
 * mirrors what the server reports. A toggle is optimistic because the write goes
 * through an engine reload; a failure restores the last server-known value
 * rather than claiming the provider is on when the engine never saw it.
 */
export function useFreeTier(client: FreeTierClient | null | undefined) {
  const [status, setStatus] = useState<SofiaFreeTierStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!client) return;
    setLoading(true);
    setError(null);
    try {
      setStatus(await client.getFreeTierStatus());
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
    async (enabled: boolean) => {
      if (!client) return;
      const previous = status;
      setBusy(true);
      setError(null);
      setStatus((current) => (current ? { ...current, providerEnabled: enabled } : current));
      try {
        const result = await client.setFreeTierEnabled(enabled);
        setStatus((current) => (current ? { ...current, providerEnabled: result.enabled } : current));
        // The allowlist and model list can change with the contract, so re-read
        // rather than trusting the toggle response.
        void refresh();
      } catch (cause) {
        setStatus(previous);
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    },
    [client, status, refresh],
  );

  return { status, loading, busy, error, refresh, setEnabled };
}
