import type { NormalizedTurn, SessionStats, TodoItem, SessionInfo, HaveInfo } from "../../../types/protocol";
import { hashTurn } from "../../../types/protocol";

export const PANE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const MAX_CACHED_PANES = 10;

export interface PaneCacheEntry {
  paneId: string;
  sessionId: string;
  savedAt: number;
  lastAccess: number;
  turns: NormalizedTurn[];
  sessionStats?: SessionStats | null;
  sessionTitle?: string | null;
  todos?: TodoItem[] | null;
  session?: SessionInfo | null;
}

const DB_NAME = "pigeon";
const DB_VERSION = 1;
const STORE_NAME = "paneCache";

const metaIndex = new Map<string, { sessionId: string; turnCount: number; lastTurnHash: string }>();

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      return reject(new Error("IndexedDB unavailable"));
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "paneId" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function updateMeta(entry: PaneCacheEntry): void {
  const turnCount = entry.turns.length;
  const lastTurnHash = turnCount > 0 ? hashTurn(entry.turns[turnCount - 1]) : "";
  metaIndex.set(entry.paneId, {
    sessionId: entry.sessionId,
    turnCount,
    lastTurnHash,
  });
}

function getAllEntries(db: IDBDatabase): Promise<PaneCacheEntry[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const req = store.getAll();
    req.onsuccess = () => resolve((req.result as PaneCacheEntry[]) || []);
    req.onerror = () => reject(req.error);
  });
}

export async function load(paneId: string): Promise<PaneCacheEntry | null> {
  try {
    const db = await openDb();
    const entry = await new Promise<PaneCacheEntry | null>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(paneId);
      req.onsuccess = () => {
        const val = req.result as PaneCacheEntry | undefined;
        if (!val) return resolve(null);
        if (Date.now() - val.savedAt > PANE_CACHE_TTL_MS) {
          store.delete(paneId);
          return resolve(null);
        }
        val.lastAccess = Date.now();
        store.put(val);
        resolve(val);
      };
      req.onerror = () => reject(req.error);
    });
    if (entry) {
      updateMeta(entry);
    } else {
      metaIndex.delete(paneId);
    }
    return entry;
  } catch {
    return null;
  }
}

export async function save(
  paneId: string,
  entry: {
    sessionId: string;
    turns: NormalizedTurn[];
    sessionStats?: SessionStats | null;
    sessionTitle?: string | null;
    todos?: TodoItem[] | null;
    session?: SessionInfo | null;
  }
): Promise<void> {
  if (!entry.sessionId) return;
  try {
    const db = await openDb();
    const all = await getAllEntries(db);
    const now = Date.now();
    const fullEntry: PaneCacheEntry = {
      paneId,
      sessionId: entry.sessionId,
      savedAt: now,
      lastAccess: now,
      turns: entry.turns,
      sessionStats: entry.sessionStats,
      sessionTitle: entry.sessionTitle,
      todos: entry.todos,
      session: entry.session,
    };

    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const req = store.put(fullEntry);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
    updateMeta(fullEntry);

    // Evict oldest if exceeding MAX_CACHED_PANES
    const pool = all.filter((e) => e.paneId !== paneId);
    pool.push(fullEntry);
    if (pool.length > MAX_CACHED_PANES) {
      pool.sort((a, b) => b.lastAccess - a.lastAccess);
      const toDelete = pool.slice(MAX_CACHED_PANES);
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      for (const d of toDelete) {
        store.delete(d.paneId);
        metaIndex.delete(d.paneId);
      }
    }
  } catch {
    // storage unavailable
  }
}

export async function remove(paneId: string): Promise<void> {
  metaIndex.delete(paneId);
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const req = store.delete(paneId);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch {}
}

export async function clearAll(): Promise<void> {
  metaIndex.clear();
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const req = store.clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch {}
}

export async function sweep(alivePaneIds?: string[]): Promise<void> {
  try {
    const db = await openDb();
    const all = await getAllEntries(db);
    const now = Date.now();
    const aliveSet = alivePaneIds ? new Set(alivePaneIds) : null;
    const toDelete: string[] = [];
    const valid: PaneCacheEntry[] = [];

    for (const e of all) {
      if (now - e.savedAt > PANE_CACHE_TTL_MS) {
        toDelete.push(e.paneId);
      } else if (aliveSet && !aliveSet.has(e.paneId)) {
        toDelete.push(e.paneId);
      } else {
        valid.push(e);
      }
    }

    if (valid.length > MAX_CACHED_PANES) {
      valid.sort((a, b) => b.lastAccess - a.lastAccess);
      const surplus = valid.slice(MAX_CACHED_PANES);
      for (const s of surplus) toDelete.push(s.paneId);
    }

    if (toDelete.length > 0) {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      for (const id of toDelete) {
        store.delete(id);
        metaIndex.delete(id);
      }
    }

    const remaining = valid.filter((v) => !toDelete.includes(v.paneId));
    metaIndex.clear();
    for (const r of remaining) {
      updateMeta(r);
    }
  } catch {}
}

export function meta(paneId: string): HaveInfo | null {
  const m = metaIndex.get(paneId);
  if (!m) return null;
  return { sessionId: m.sessionId, turnCount: m.turnCount, lastTurnHash: m.lastTurnHash };
}

/** One-time migration removing localStorage keys starting with pigeon_pane_cache_ */
export function migrateLocalStorageCache(): void {
  try {
    if (typeof localStorage === "undefined") return;
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith("pigeon_pane_cache_")) {
        keysToRemove.push(key);
      }
    }
    for (const k of keysToRemove) localStorage.removeItem(k);
  } catch {}
}
