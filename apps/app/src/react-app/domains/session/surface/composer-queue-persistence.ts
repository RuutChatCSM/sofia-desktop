import type { QueuedComposerItem } from "./composer-state-store";

export type QueuedComposerShape = Record<string, QueuedComposerItem[]>;
export type ComposerQueueBackend = {
  load: () => Promise<QueuedComposerShape>;
  save: (shape: QueuedComposerShape) => Promise<void>;
};

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("sofia-composer-queue", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("queue");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** IndexedDB keeps the File bytes; object URLs belong only to this renderer. */
export function composerQueueIndexedDbBackend(): ComposerQueueBackend {
  return {
    load: async () => {
      const database = await openDatabase();
      return new Promise<QueuedComposerShape>((resolve, reject) => {
        const transaction = database.transaction("queue", "readonly");
        const request: IDBRequest<QueuedComposerShape | undefined> = transaction.objectStore("queue").get("sessions");
        transaction.oncomplete = () => { database.close(); resolve(request.result ?? {}); };
        transaction.onabort = () => { database.close(); reject(transaction.error); };
      });
    },
    save: async (shape) => {
      const database = await openDatabase();
      return new Promise<void>((resolve, reject) => {
        const transaction = database.transaction("queue", "readwrite");
        transaction.objectStore("queue").put(shape, "sessions");
        transaction.oncomplete = () => { database.close(); resolve(); };
        transaction.onabort = () => { database.close(); reject(transaction.error); };
      });
    },
  };
}

export function durableComposerQueue(shape: QueuedComposerShape): QueuedComposerShape {
  return Object.fromEntries(Object.entries(shape).map(([sessionId, items]) => [sessionId, items.map((item) => ({
    ...item,
    draft: { ...item.draft, attachments: item.draft.attachments.map(({ previewUrl: _previewUrl, ...attachment }) => attachment) },
  }))]));
}

export function recoverComposerQueue(shape: QueuedComposerShape): QueuedComposerShape {
  return Object.fromEntries(Object.entries(shape).map(([sessionId, items]) => [sessionId, items.map((item) => ({
    ...item,
    recovered: true,
    deliveryState: item.deliveryState === "sending" ? "outcome-unknown" : item.deliveryState ?? "ready",
    draft: { ...item.draft, attachments: item.draft.attachments.map((attachment) => ({
      ...attachment,
      ...(attachment.kind === "image" ? { previewUrl: URL.createObjectURL(attachment.file) } : {}),
    })) },
  }))]));
}

/** Save in order; a later accepted removal cannot be overwritten by an older save. */
export class ComposerQueuePersistence {
  private pending: Promise<void> = Promise.resolve();
  constructor(private backend: ComposerQueueBackend) {}
  load() { return this.backend.load().then(recoverComposerQueue); }
  save(shape: QueuedComposerShape) {
    const snapshot = durableComposerQueue(shape);
    this.pending = this.pending.catch(() => undefined).then(() => this.backend.save(snapshot));
    return this.pending;
  }
  flush() { return this.pending; }
}
