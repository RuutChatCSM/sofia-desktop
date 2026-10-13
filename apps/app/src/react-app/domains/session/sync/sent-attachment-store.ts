import type { UIMessage } from "ai";

/**
 * Attachments this client sent, kept per session so they outlive a reload.
 *
 * The Codex engine echoes a user turn as text only, so a sent image is in the
 * transcript purely because the app remembers it. The in-memory copy in the
 * session store dies with the window — which is why an attached image used to
 * disappear from an old session. This store is the durable half: the message
 * prompt text and user-message ordinal identify the echo; ordered display
 * parts retain text/file placement. Small media rides as data URLs and larger
 * files retain a workspace path for on-demand preview.
 *
 * Payloads live in IndexedDB, not localStorage: an image is base64, and putting
 * that in the key/value store the rest of the app shares would eat its quota.
 * Reads stay synchronous (from the hydrated cache) because the transcript is
 * built on the render path; `subscribeSentAttachments` fires once hydration
 * lands so the transcript can be rebuilt.
 */
export type SentAttachments = {
  text: string;
  displayText?: string;
  orderedParts?: boolean;
  userMessageOrdinal?: number;
  parts: UIMessage["parts"];
};

/** Keep the newest N attachment-bearing user messages per session. */
const MAX_MESSAGES_PER_SESSION = 40;
/** One inline payload: drop anything past this rather than risk the quota. */
const MAX_PART_BYTES = 1_500_000;
/** Whole-session budget, so one busy conversation cannot evict every other. */
const MAX_SESSION_BYTES = 4_000_000;

const DB_NAME = "sofia-sent-attachments";
const DB_VERSION = 1;
const STORE_NAME = "sessions";

/** Where payloads are kept. Swapped in tests; IndexedDB in the app. */
export type SentAttachmentBackend = {
  load: () => Promise<Record<string, SentAttachments[]>>;
  save: (shape: Record<string, SentAttachments[]>) => Promise<void>;
};

type PersistedShape = Record<string, SentAttachments[]>;

let cache: Map<string, SentAttachments[]> | null = null;
let backend: SentAttachmentBackend | null = null;
let hydration: Promise<void> | null = null;
let pendingSave: Promise<void> = Promise.resolve();
const listeners = new Set<() => void>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitize(shape: unknown): PersistedShape {
  const next: PersistedShape = {};
  if (!isRecord(shape)) return next;
  for (const [sessionId, value] of Object.entries(shape)) {
    if (!sessionId || !Array.isArray(value)) continue;
    const entries: SentAttachments[] = [];
    for (const entry of value) {
      if (!isRecord(entry) || typeof entry.text !== "string" || !Array.isArray(entry.parts)) continue;
      entries.push({ text: entry.text, ...(typeof entry.displayText === "string" ? { displayText: entry.displayText } : {}), ...(entry.orderedParts === true ? { orderedParts: true } : {}), ...(Number.isInteger(entry.userMessageOrdinal) ? { userMessageOrdinal: entry.userMessageOrdinal as number } : {}), parts: entry.parts as UIMessage["parts"] });
    }
    if (entries.length) next[sessionId] = entries;
  }
  return next;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("indexedDB open failed"));
  });
}

/** The app's backend: one object store, one record per session. */
export function indexedDbBackend(): SentAttachmentBackend {
  const withStore = async <T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await openDatabase();
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, mode);
      const request = run(transaction.objectStore(STORE_NAME));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("indexedDB request failed"));
      transaction.oncomplete = () => db.close();
    });
  };
  return {
    load: async () => {
      const keys = await withStore<IDBValidKey[]>("readonly", (store) => store.getAllKeys());
      const values = await withStore<unknown[]>("readonly", (store) => store.getAll());
      const shape: PersistedShape = {};
      keys.forEach((key, index) => {
        if (typeof key === "string") shape[key] = sanitize({ [key]: values[index] })[key] ?? [];
      });
      return shape;
    },
    save: async (shape) => {
      const db = await openDatabase();
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, "readwrite");
        const store = transaction.objectStore(STORE_NAME);
        store.clear();
        for (const [sessionId, entries] of Object.entries(shape)) store.put(entries, sessionId);
        transaction.oncomplete = () => {
          db.close();
          resolve();
        };
        transaction.onerror = () => reject(transaction.error ?? new Error("indexedDB write failed"));
      });
    },
  };
}

function defaultBackend(): SentAttachmentBackend | null {
  return typeof indexedDB === "undefined" ? null : indexedDbBackend();
}

function notify() {
  for (const listener of listeners) listener();
}

function flush() {
  if (!cache || !backend) return;
  const shape: PersistedShape = {};
  for (const [sessionId, entries] of cache) shape[sessionId] = entries;
  const destination = backend;
  pendingSave = pendingSave.catch(() => undefined).then(() => destination.save(shape));
  void pendingSave.catch(() => undefined);
}

/** Resolves once the durable cache is loaded (and after every later save). */
export function whenSentAttachmentsReady(): Promise<void> {
  hydration ??= (async () => {
    const source = backend ?? defaultBackend();
    backend = source;
    if (!source) return;
    try {
      const stored = await source.load();
      const loaded = load();
      for (const [sessionId, entries] of Object.entries(stored)) {
        if (!entries.length) continue;
        const existing = loaded.get(sessionId) ?? [];
        if (!existing.length) {
          loaded.set(sessionId, entries);
          continue;
        }
        // A session already written since boot holds the fresher tail: keep the
        // stored history in front of it and let the in-memory copy win per
        // message, so a send that races hydration is never dropped.
        const same = (left: SentAttachments, right: SentAttachments) => JSON.stringify(left) === JSON.stringify(right);
        let overlap = Math.min(entries.length, existing.length);
        while (overlap > 0 && !entries.slice(-overlap).every((entry, index) => same(entry, existing[index]))) overlap -= 1;
        loaded.set(sessionId, [...entries, ...existing.slice(overlap)].slice(-MAX_MESSAGES_PER_SESSION));
      }
    } catch {
      // A missing or broken database must never break the transcript.
    }
    notify();
  })();
  return hydration.then(() => pendingSave.catch(() => undefined));
}

function load(): Map<string, SentAttachments[]> {
  cache ??= new Map();
  return cache;
}

function partsByteLength(parts: UIMessage["parts"]): number {
  let total = 0;
  for (const part of parts) {
    if (part.type === "file" && typeof part.url === "string") total += part.url.length;
  }
  return total;
}

/** Why a part is not durable; "" when it is. */
function rejectionReason(part: UIMessage["parts"][number]): string {
  if (part.type === "text") return "";
  if (part.type !== "file") return "unsupported part";
  if (typeof part.url !== "string" || (!part.url.startsWith("data:") && !part.url.startsWith("file:"))) return "no durable URL";
  if (part.url.length > MAX_PART_BYTES) return "attachment too large to keep";
  return "";
}

/**
 * Record the attachments sent with one user message. Oversized or non-inline
 * parts are skipped, and the session keeps only its newest messages: losing an
 * old image is better than making every session unrenderable.
 */
export function recordSentAttachments(sessionId: string, text: string, parts: UIMessage["parts"], displayText?: string, orderedParts = false, userMessageOrdinal?: number): void {
  const id = sessionId.trim();
  const body = text.trim();
  const durable = parts.filter((part) => !rejectionReason(part));
  // An image-only turn has no text at all; the record is still the only thing
  // that puts the image back after a reload, so an empty key is allowed.
  if (!id || !durable.some((part) => part.type === "file")) return;

  void whenSentAttachmentsReady();
  const store = load();
  const existing = store.get(id) ?? [];
  const next = [...existing, { text: body, ...(displayText !== undefined ? { displayText } : {}), ...(orderedParts ? { orderedParts: true } : {}), ...(userMessageOrdinal !== undefined ? { userMessageOrdinal } : {}), parts: durable }];
  const capped = next.slice(-MAX_MESSAGES_PER_SESSION);
  while (capped.length > 1 && capped.reduce((total, entry) => total + partsByteLength(entry.parts), 0) > MAX_SESSION_BYTES) {
    capped.shift();
  }
  store.set(id, capped);
  flush();
}

/** Attachments sent for a session, oldest first. */
export function sentAttachments(sessionId: string): SentAttachments[] {
  return load().get(sessionId.trim()) ?? [];
}

/** Rebuild transcripts when the durable copy lands or changes. */
export function subscribeSentAttachments(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test seam: install a backend (or null for cache-only) and drop the cache. */
export function setSentAttachmentBackend(next: SentAttachmentBackend | null): void {
  backend = next;
  cache = null;
  hydration = null;
}

/** Test seam: drop the in-memory cache so the next read comes from storage. */
export function resetSentAttachmentCache(): void {
  cache = null;
  hydration = null;
}
