// Everything Dock keeps on the phone lives in one IndexedDB database:
//   chunks  the virtual disk's written chunks (index -> Uint8Array)
//   kv      settings and sync bookkeeping
//   apps    the dock's app list

const DB_NAME = "dock";
let dbPromise = null;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore("chunks");
        db.createObjectStore("kv");
        db.createObjectStore("apps", { keyPath: "id" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("storage transaction aborted"));
  });
}

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export const kv = {
  async get(key, fallback) {
    const db = await open();
    const value = await request(db.transaction("kv").objectStore("kv").get(key));
    return value === undefined ? fallback : value;
  },
  async set(key, value) {
    const db = await open();
    const tx = db.transaction("kv", "readwrite");
    tx.objectStore("kv").put(value, key);
    return done(tx);
  },
  async delete(key) {
    const db = await open();
    const tx = db.transaction("kv", "readwrite");
    tx.objectStore("kv").delete(key);
    return done(tx);
  },
};

export const apps = {
  async all() {
    const db = await open();
    return request(db.transaction("apps").objectStore("apps").getAll());
  },
  async put(app) {
    const db = await open();
    const tx = db.transaction("apps", "readwrite");
    tx.objectStore("apps").put(app);
    return done(tx);
  },
  async delete(id) {
    const db = await open();
    const tx = db.transaction("apps", "readwrite");
    tx.objectStore("apps").delete(id);
    return done(tx);
  },
  async replaceAll(list) {
    const db = await open();
    const tx = db.transaction("apps", "readwrite");
    tx.objectStore("apps").clear();
    for (const app of list) tx.objectStore("apps").put(app);
    return done(tx);
  },
};

/**
 * The disk overlay (see disk.js). putMany also records, in the same transaction, which
 * chunks have changed since the last backup, so the two can never disagree.
 */
export const overlay = {
  async keys() {
    const db = await open();
    return request(db.transaction("chunks").objectStore("chunks").getAllKeys());
  },
  async get(index) {
    const db = await open();
    return request(db.transaction("chunks").objectStore("chunks").get(index));
  },
  async putMany(entries, { markPending = true } = {}) {
    const db = await open();
    const tx = db.transaction(["chunks", "kv"], "readwrite");
    const chunks = tx.objectStore("chunks");
    // put() copies each chunk right here, before this function first yields.
    for (const [index, chunk] of entries) chunks.put(chunk, index);
    if (markPending) {
      const store = tx.objectStore("kv");
      const read = store.get("backup.pending");
      read.onsuccess = () => {
        const pending = new Set(read.result || []);
        for (const [index] of entries) pending.add(index);
        store.put([...pending], "backup.pending");
      };
    }
    return done(tx);
  },
  async count() {
    const db = await open();
    return request(db.transaction("chunks").objectStore("chunks").count());
  },
  async clear() {
    const db = await open();
    const tx = db.transaction(["chunks", "kv"], "readwrite");
    tx.objectStore("chunks").clear();
    tx.objectStore("kv").delete("backup.pending");
    return done(tx);
  },
};

export async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist();
  } catch { /* not supported */ }
  return false;
}
