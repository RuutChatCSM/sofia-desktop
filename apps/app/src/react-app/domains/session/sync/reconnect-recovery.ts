/** Coalesce ready events while retaining one trailing read for a later stream gap. */
export function createReconnectRecovery(
  recover: () => Promise<void>,
  signal: AbortSignal,
  onError: (error: unknown) => void,
): () => void {
  let running = false;
  let requested = false;
  return () => {
    if (signal.aborted) return;
    requested = true;
    if (running) return;
    running = true;
    void (async () => {
      try {
        while (requested && !signal.aborted) {
          requested = false;
          try {
            await recover();
          } catch (error) {
            if (!signal.aborted) onError(error);
          }
        }
      } finally {
        running = false;
      }
    })();
  };
}

/** Refresh completed threads independently, coalescing repeated events per thread. */
export function createSessionHistoryRecovery(
  recover: (sessionId: string) => Promise<void>,
  signal: AbortSignal,
  onError: (error: unknown) => void,
): (sessionId: string) => void {
  const requests = new Map<string, () => void>();
  return sessionId => {
    if (signal.aborted) return;
    let request = requests.get(sessionId);
    if (!request) {
      request = createReconnectRecovery(() => recover(sessionId), signal, onError);
      requests.set(sessionId, request);
    }
    request();
  };
}
