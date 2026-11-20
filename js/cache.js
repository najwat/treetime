// A small persistent cache (IndexedDB) for loaded tree tiles and summary counts, so
// repeat visits are fast. Entries carry the time they were stored; callers decide
// how old is too old. Everything degrades to "no cache" if IndexedDB is unavailable.
const DB_NAME = 'treetime-cache';
const STORE = 'kv';
const MAX_ENTRIES = 80; // tiles are ~0.1–1 MB each once parsed; keep the footprint bounded

let dbPromise = null;
function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'key' }).createIndex('at', 'at');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch (e) { resolve(null); }
  });
  return dbPromise;
}

// -> { value, at } or null
export async function cacheGet(key) {
  const db = await open();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const req = db.transaction(STORE).objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result ? { value: req.result.value, at: req.result.at } : null);
      req.onerror = () => resolve(null);
    } catch (e) { resolve(null); }
  });
}

export async function cacheSet(key, value) {
  const db = await open();
  if (!db) return;
  await new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({ key, value, at: Date.now() });
      tx.oncomplete = resolve; tx.onerror = resolve; tx.onabort = resolve;
    } catch (e) { resolve(); }
  });
  prune(db);
}

// Drop the oldest entries beyond MAX_ENTRIES.
function prune(db) {
  try {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const count = store.count();
    count.onsuccess = () => {
      let extra = count.result - MAX_ENTRIES;
      if (extra <= 0) return;
      store.index('at').openCursor().onsuccess = (e) => {
        const cur = e.target.result;
        if (!cur || extra <= 0) return;
        cur.delete(); extra -= 1; cur.continue();
      };
    };
  } catch (e) { /* ignore */ }
}
