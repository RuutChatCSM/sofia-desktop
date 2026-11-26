import type { BrowserSessionDockState } from "@/app/lib/desktop-types";

export function browserSessionDockStateKey(state: BrowserSessionDockState): string {
  return [state.title, state.tone, state.meta.join("\u001f"), state.note ?? "", state.running, state.mode, state.dark].join("\u001e");
}

type TimerHandle = ReturnType<typeof setTimeout>;

export type DockStatePublisherOptions = {
  intervalMs?: number;
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => TimerHandle;
  cancel?: (handle: TimerHandle) => void;
};

/**
 * At most one dock update per interval, always the newest. Streaming can
 * change the turn many times a second; the native dock only needs enough to
 * read as live.
 */
export function createDockStatePublisher(
  send: (state: BrowserSessionDockState) => void,
  options: DockStatePublisherOptions = {},
) {
  const intervalMs = options.intervalMs ?? 250;
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const cancel = options.cancel ?? ((handle) => clearTimeout(handle));
  let latest: BrowserSessionDockState | null = null;
  let timer: TimerHandle | null = null;
  let lastSentAt = Number.NEGATIVE_INFINITY;
  let lastKey: string | null = null;

  const emit = () => {
    timer = null;
    if (!latest) return;
    const next = latest;
    latest = null;
    lastSentAt = now();
    lastKey = browserSessionDockStateKey(next);
    send(next);
  };

  return {
    publish(state: BrowserSessionDockState) {
      const key = browserSessionDockStateKey(state);
      if (key === lastKey && timer === null) return;
      latest = state;
      const wait = intervalMs - (now() - lastSentAt);
      if (wait <= 0) {
        if (timer !== null) {
          cancel(timer);
          timer = null;
        }
        emit();
        return;
      }
      if (timer === null) timer = schedule(emit, wait);
    },
    flush() {
      if (timer !== null) {
        cancel(timer);
        timer = null;
      }
      emit();
    },
    stop() {
      if (timer !== null) {
        cancel(timer);
        timer = null;
      }
      latest = null;
    },
  };
}
