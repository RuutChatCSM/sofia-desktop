// Native browser restoration is separate from renderer tab descriptors. Keep
// inactive sessions on disk and never recreate agent leases or pending actions.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const MAX_BROWSER_WORKSPACE_BYTES = 16 * 1024 * 1024;
const MAX_TABS = 100;
const MAX_HISTORY = 100;
const text = (value, max = 8192) => typeof value === "string" && value.length <= max ? value : null;
const pageUrl = value => {
  const url = text(value);
  if (url === "about:blank") return url;
  try { return ["https:", "http:"].includes(new URL(url).protocol) ? url : null; } catch { return null; }
};
function normalizeTab(value) {
  if (!value || typeof value !== "object") return null;
  const id = text(value.id, 256), scopeId = text(value.scopeId, 2048), url = pageUrl(value.url);
  if (!id || !scopeId || !url) return null;
  const entries = Array.isArray(value.navigation?.entries) ? value.navigation.entries : [];
  const index = value.navigation?.index;
  // Drop the entire history if any URL or index is invalid; keep its current URL.
  let navigation = null;
  if (entries.length > 0 && entries.length <= MAX_HISTORY && Number.isInteger(index) && index >= 0 && index < entries.length) {
    const normalized = entries.map(entry => {
      const url = pageUrl(entry?.url);
      if (!url) return null;
      const pageState = text(entry.pageState, 128 * 1024);
      return { url, title: text(entry.title, 2048) ?? "", ...(pageState ? { pageState } : {}) };
    });
    if (normalized.every(Boolean)) navigation = { entries: normalized, index };
  }
  const favicon = text(value.favicon, 16384);
  const safeFavicon = favicon && (pageUrl(favicon) || /^data:image\/(?:png|jpeg|webp|x-icon);base64,[A-Za-z0-9+/=]+$/.test(favicon)) ? favicon : null;
  return { id, scopeId, url, title: text(value.title, 2048) ?? "", favicon: safeFavicon, navigation,
    updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : 0 };
}

/** @param {string} filePath @param {{onError?: (error: Error) => void}} [options] */
export function createBrowserWorkspaceStore(filePath, { onError = (_error) => {} } = {}) {
  let tabs = new Map();
  let selected = {};
  try {
    if (existsSync(filePath) && statSync(filePath).size <= MAX_BROWSER_WORKSPACE_BYTES) {
      const raw = JSON.parse(readFileSync(filePath, "utf8"));
      if (raw.version === 1 && Array.isArray(raw.tabs)) {
        for (const value of raw.tabs.slice(0, MAX_TABS)) {
          const tab = normalizeTab(value);
          if (tab && !tabs.has(tab.id)) tabs.set(tab.id, tab);
        }
        if (raw.selected && typeof raw.selected === "object") {
          for (const [scope, id] of Object.entries(raw.selected)) {
            if (tabs.get(id)?.scopeId === scope) selected[scope] = id;
          }
        }
      }
    }
  } catch (error) { onError(error); }
  function boundedSnapshot() {
    const newest = [...tabs.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_TABS);
    const accepted = new Set();
    let bytes = 128;
    for (const tab of newest) {
      const size = Buffer.byteLength(JSON.stringify(tab));
      if (bytes + size > MAX_BROWSER_WORKSPACE_BYTES - 64 * 1024) continue;
      bytes += size; accepted.add(tab.id);
    }
    tabs = new Map([...tabs].filter(([id]) => accepted.has(id)));
    selected = Object.fromEntries(Object.entries(selected).filter(([scope, id]) => tabs.get(id)?.scopeId === scope));
    return { version: 1, tabs: [...tabs.values()], selected };
  }
  return {
    list(scopeId) { return [...tabs.values()].filter(tab => tab.scopeId === scopeId); },
    selected(scopeId) { return selected[scopeId] ?? null; },
    upsert(value) {
      const tab = normalizeTab(value);
      if (!tab) return;
      const existing = tabs.get(tab.id);
      if (existing && existing.scopeId !== tab.scopeId) return;
      tabs.set(tab.id, tab);
    },
    select(scopeId, id) { if (tabs.get(id)?.scopeId === scopeId) selected[scopeId] = id; },
    reorder(scopeId, ids) {
      const current = this.list(scopeId);
      if (ids.length !== current.length || new Set(ids).size !== ids.length || ids.some(id => tabs.get(id)?.scopeId !== scopeId)) return;
      const next = new Map([...tabs].filter(([, tab]) => tab.scopeId !== scopeId));
      for (const id of ids) next.set(id, tabs.get(id));
      tabs = next;
    },
    remove(id) { tabs.delete(id); for (const scope of Object.keys(selected)) if (selected[scope] === id) delete selected[scope]; },
    flush() {
      const temporary = `${filePath}.${randomUUID()}.tmp`;
      try {
        mkdirSync(path.dirname(filePath), { recursive: true });
        writeFileSync(temporary, JSON.stringify(boundedSnapshot()), { mode: 0o600 });
        renameSync(temporary, filePath);
      } catch (error) { rmSync(temporary, { force: true }); onError(error); }
    },
  };
}
