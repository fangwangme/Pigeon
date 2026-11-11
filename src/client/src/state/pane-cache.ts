import type { NormalizedTurn, SessionStats, TodoItem, SessionInfo, HaveInfo, QueuedPrompt, AgentStatus } from "../../../types/protocol";
import { hashTurn } from "../../../types/protocol";

export const PANE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const MAX_CACHED_PANES = 10;

export interface PaneCacheEntry {
  paneId: string;
  sessionId: string;
  savedAt: number;
  lastAccess: number;
  turns: NormalizedTurn[];
  seq?: number;
  agentStatus?: AgentStatus;
  sessionStats?: SessionStats | null;
  sessionTitle?: string | null;
  todos?: TodoItem[] | null;
  session?: SessionInfo | null;
  queue?: QueuedPrompt[];
}

export const DB_NAME = "pigeon";
export const DB_VERSION = 2;
export const STORE_NAME = "paneCache";

const metaIndex = new Map<string, { sessionId: string; turnCount: number; lastTurnHash: string }>();
const inMemoryViews = new Map<string, PaneCacheEntry>();

export function getMemoryPaneView(paneId: string): PaneCacheEntry | undefined {
  return inMemoryViews.get(paneId);
}

export function applyPaneTail(payload: {
  paneId: string;
  agentStatus: AgentStatus;
  seq: number;
  sessionId: string;
  turns: NormalizedTurn[];
}): void {
  const existing = inMemoryViews.get(payload.paneId);
  const now = Date.now();
  let entry: PaneCacheEntry;

  if (existing && existing.sessionId === payload.sessionId) {
    const existingIndex = payload.turns.length > 0
      ? existing.turns.findIndex((t) => t.turnId === payload.turns[0].turnId)
      : -1;
    let mergedTurns: NormalizedTurn[];
    if (existingIndex !== -1) {
      mergedTurns = [...existing.turns.slice(0, existingIndex), ...payload.turns];
    } else {
      mergedTurns = payload.turns;
    }

    entry = {
      ...existing,
      sessionId: payload.sessionId,
      seq: payload.seq,
      agentStatus: payload.agentStatus,
      turns: mergedTurns,
      savedAt: now,
      lastAccess: now,
    };
  } else {
    entry = {
      paneId: payload.paneId,
      sessionId: payload.sessionId,
      seq: payload.seq,
      agentStatus: payload.agentStatus,
      turns: payload.turns,
      savedAt: now,
      lastAccess: now,
    };
  }

  inMemoryViews.set(payload.paneId, entry);
  if (inMemoryViews.size > MAX_CACHED_PANES) {
    const oldestKey = inMemoryViews.keys().next().value;
    if (oldestKey && oldestKey !== payload.paneId) inMemoryViews.delete(oldestKey);
  }
  if (existing) {
    updateMeta(entry);
  }
}

let dbInstance: IDBDatabase | null = null;
let dbOpenPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") {
    return Promise.resolve(null);
  }
  if (dbInstance) {
    return Promise.resolve(dbInstance);
  }
  if (dbOpenPromise) {
    return dbOpenPromise;
  }

  dbOpenPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      let store: IDBObjectStore;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        store = db.createObjectStore(STORE_NAME, { keyPath: "paneId" });
      } else {
        store = req.transaction!.objectStore(STORE_NAME);
      }
      if (!store.indexNames.contains("by_lastAccess")) {
        store.createIndex("by_lastAccess", "lastAccess");
      }
      if (!store.indexNames.contains("by_savedAt")) {
        store.createIndex("by_savedAt", "savedAt");
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      dbInstance = db;
      dbOpenPromise = null;
      db.onversionchange = () => {
        db.close();
        dbInstance = null;
      };
      db.onclose = () => {
        dbInstance = null;
      };
      resolve(db);
    };
    req.onblocked = () => {
      console.error("[Pigeon] IndexedDB open blocked by existing connection");
      dbOpenPromise = null;
      reject(new Error("IndexedDB open blocked"));
    };
    req.onerror = () => {
      console.error("[Pigeon] Failed to open IndexedDB:", req.error);
      dbOpenPromise = null;
      reject(req.error);
    };
  });

  return dbOpenPromise;
}

function updateMeta(entry: { paneId: string; sessionId: string; turns: NormalizedTurn[] }): void {
  const turnCount = entry.turns.length;
  const lastTurnHash = turnCount > 0 ? hashTurn(entry.turns[turnCount - 1]) : "";
  metaIndex.set(entry.paneId, {
    sessionId: entry.sessionId,
    turnCount,
    lastTurnHash,
  });
}

export async function load(paneId: string): Promise<PaneCacheEntry | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise<PaneCacheEntry | null>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(paneId);
    req.onsuccess = () => {
      const val = req.result as PaneCacheEntry | undefined;
      if (!val) {
        metaIndex.delete(paneId);
        inMemoryViews.delete(paneId);
        return resolve(null);
      }
      if (Date.now() - val.savedAt > PANE_CACHE_TTL_MS) {
        store.delete(paneId);
        metaIndex.delete(paneId);
        inMemoryViews.delete(paneId);
        return resolve(null);
      }
      val.lastAccess = Date.now();
      store.put(val);
      updateMeta(val);
      inMemoryViews.set(paneId, val);
      resolve(val);
    };
    req.onerror = () => {
      console.error("[Pigeon] Failed to load pane cache for", paneId, req.error);
      reject(req.error);
    };
  });
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
    queue?: QueuedPrompt[];
  }
): Promise<void> {
  if (!entry.sessionId) return;
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
    queue: entry.queue,
  };
  inMemoryViews.set(paneId, fullEntry);
  updateMeta(fullEntry);

  const db = await openDb();
  if (!db) return;

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const putReq = store.put(fullEntry);
    putReq.onerror = () => reject(putReq.error);

    // Evict oldest entries exceeding MAX_CACHED_PANES without loading full turns
    const countReq = store.count();
    countReq.onsuccess = () => {
      const count = countReq.result;
      if (count > MAX_CACHED_PANES) {
        const excess = count - MAX_CACHED_PANES;
        const accessIdx = store.index("by_lastAccess");
        const curReq = accessIdx.openKeyCursor();
        let evicted = 0;
        curReq.onsuccess = () => {
          const cursor = curReq.result;
          if (cursor && evicted < excess) {
            const evictId = cursor.primaryKey as string;
            if (evictId !== paneId) {
              store.delete(evictId);
              metaIndex.delete(evictId);
              inMemoryViews.delete(evictId);
              evicted++;
            }
            cursor.continue();
          }
        };
        curReq.onerror = () => reject(curReq.error);
      }
    };
    countReq.onerror = () => reject(countReq.error);

    tx.oncomplete = () => resolve();
    tx.onerror = () => {
      console.error("[Pigeon] Failed to save pane cache for", paneId, tx.error);
      reject(tx.error);
    };
  });
}

export async function remove(paneId: string): Promise<void> {
  inMemoryViews.delete(paneId);
  metaIndex.delete(paneId);
  const db = await openDb();
  if (!db) return;
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const req = store.delete(paneId);
    req.onsuccess = () => resolve();
    req.onerror = () => {
      console.error("[Pigeon] Failed to remove pane cache for", paneId, req.error);
      reject(req.error);
    };
  });
}

export async function clearAll(): Promise<void> {
  inMemoryViews.clear();
  metaIndex.clear();
  const db = await openDb();
  if (!db) return;
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const req = store.clear();
    req.onsuccess = () => resolve();
    req.onerror = () => {
      console.error("[Pigeon] Failed to clear pane cache", req.error);
      reject(req.error);
    };
  });
}

export async function sweep(alivePaneIds?: string[]): Promise<void> {
  const db = await openDb();
  if (!db) return;

  const now = Date.now();
  const aliveSet = alivePaneIds ? new Set(alivePaneIds) : null;

  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);

    // 1. Delete TTL-expired entries using by_savedAt index without loading turns
    const expiredRange = IDBKeyRange.upperBound(now - PANE_CACHE_TTL_MS);
    const savedIdx = store.index("by_savedAt");
    const expReq = savedIdx.openKeyCursor(expiredRange);
    expReq.onsuccess = () => {
      const cursor = expReq.result;
      if (cursor) {
        const id = cursor.primaryKey as string;
        store.delete(id);
        metaIndex.delete(id);
        inMemoryViews.delete(id);
        cursor.continue();
      }
    };
    expReq.onerror = () => reject(expReq.error);

    // 2. If alivePaneIds is provided, delete dead panes using key cursor
    if (aliveSet) {
      const keyReq = store.openKeyCursor();
      keyReq.onsuccess = () => {
        const cursor = keyReq.result;
        if (cursor) {
          const id = cursor.primaryKey as string;
          if (!aliveSet.has(id)) {
            store.delete(id);
            metaIndex.delete(id);
            inMemoryViews.delete(id);
          }
          cursor.continue();
        }
      };
      keyReq.onerror = () => reject(keyReq.error);
    }

    // 3. LRU count eviction without loading turns
    const countReq = store.count();
    countReq.onsuccess = () => {
      const count = countReq.result;
      if (count > MAX_CACHED_PANES) {
        const excess = count - MAX_CACHED_PANES;
        const accessIdx = store.index("by_lastAccess");
        const curReq = accessIdx.openKeyCursor();
        let evicted = 0;
        curReq.onsuccess = () => {
          const cursor = curReq.result;
          if (cursor && evicted < excess) {
            const evictId = cursor.primaryKey as string;
            store.delete(evictId);
            metaIndex.delete(evictId);
            inMemoryViews.delete(evictId);
            evicted++;
            cursor.continue();
          }
        };
        curReq.onerror = () => reject(curReq.error);
      }
    };
    countReq.onerror = () => reject(countReq.error);

    tx.oncomplete = () => resolve();
    tx.onerror = () => {
      console.error("[Pigeon] Failed to sweep pane cache", tx.error);
      reject(tx.error);
    };
  });
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
  } catch (err) {
    console.error("[Pigeon] Failed to migrate localStorage pane cache:", err);
  }
}
