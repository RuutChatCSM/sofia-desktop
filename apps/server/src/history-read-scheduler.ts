/** Across workspace managers, only two history payloads may hydrate at once. */
export class HistoryReadScheduler {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  constructor(private readonly concurrency = 2) {}

  async run<T>(read: () => Promise<T>): Promise<T> {
    if (this.active >= this.concurrency) await new Promise<void>(resolve => this.waiting.push(resolve));
    else this.active += 1;
    try { return await read(); }
    finally {
      const next = this.waiting.shift();
      if (next) next(); // Transfer the existing slot without admitting a third read.
      else this.active -= 1;
    }
  }
}

export const historyReadScheduler = new HistoryReadScheduler();
