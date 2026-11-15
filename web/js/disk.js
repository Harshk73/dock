// Copy-on-write virtual disk for the emulator.
//
// The disk is split into fixed-size chunks. A read is answered from, in order:
//   1. the in-memory cache,
//   2. the local overlay (chunks the guest has written; IndexedDB in the browser),
//   3. the remote overlay (chunks restored lazily from Google Drive),
//   4. the read-only base image (static files served with the app),
//   5. zeros.
// Writes only ever touch the cache; flush() persists every dirty chunk to the local
// overlay in a single atomic batch, so the stored disk always equals the disk as the
// guest saw it at one point in time (crash-consistent, which ext4's journal handles).

export class ChunkDisk {
  /**
   * @param {object} o
   * @param {number} o.size disk size in bytes
   * @param {number} o.chunkSize
   * @param {Iterable<number>} o.basePresent indexes of non-empty base chunks
   * @param {(index: number) => Promise<Uint8Array>} o.loadBase
   * @param {{keys(): Promise<number[]>, get(i: number): Promise<Uint8Array|undefined>, putMany(entries: Array<[number, Uint8Array]>): Promise<void>}} o.overlay
   * @param {{has(i: number): boolean, get(i: number): Promise<Uint8Array>}} [o.remote]
   * @param {number} [o.maxCleanChunks] clean chunks kept in memory
   */
  constructor(o) {
    this.byteLength = o.size;
    this.chunkSize = o.chunkSize;
    this.basePresent = new Set(o.basePresent);
    this.loadBase = o.loadBase;
    this.overlay = o.overlay;
    this.remote = o.remote || null;
    this.maxCleanChunks = o.maxCleanChunks || 96;
    this.cache = new Map(); // index -> Uint8Array (insertion order = LRU order)
    this.loading = new Map(); // index -> Promise<Uint8Array>
    this.dirty = new Map(); // index -> write counter
    this.overlayKeys = new Set();
    this.pinned = new Map();
    this.onload = undefined;
    this.onactivity = undefined; // (kind: "read"|"write", bytes) => void
    this.stats = { baseLoads: 0, overlayLoads: 0, remoteLoads: 0, writes: 0, flushes: 0 };
  }

  // --- emulator buffer interface -------------------------------------------------

  load() {
    this.overlay.keys().then(keys => {
      this.overlayKeys = new Set(keys);
      this.onload && this.onload({});
    });
  }

  get(offset, len, fn) {
    this.read(offset, len).then(fn, err => {
      console.error("disk read failed", err);
      fn(new Uint8Array(len));
    });
  }

  set(offset, data, fn) {
    this.write(offset, data).then(() => fn(), err => {
      console.error("disk write failed", err);
      fn();
    });
  }

  // The emulator reads the boot sector once, asynchronously, and then expects to get
  // it back synchronously while it sets up the drive geometry.
  get_and_cache(offset, len, fn) {
    this.read(offset, len).then(data => {
      this.pinned.set(offset + ":" + len, data);
      fn(data);
    });
  }

  get_from_cache(offset, len) {
    return this.pinned.get(offset + ":" + len);
  }

  get_buffer(fn) { fn(undefined); }
  get_state() { return [this.byteLength]; }
  set_state() {}

  // --- implementation ------------------------------------------------------------

  async read(offset, len) {
    const out = new Uint8Array(len);
    const cs = this.chunkSize;
    let done = 0;
    while (done < len) {
      const pos = offset + done;
      const index = Math.floor(pos / cs);
      const within = pos - index * cs;
      const n = Math.min(cs - within, len - done);
      const chunk = this.cache.get(index) || await this.chunk(index);
      out.set(chunk.subarray(within, within + n), done);
      done += n;
    }
    this.onactivity && this.onactivity("read", len);
    return out;
  }

  async write(offset, data) {
    const cs = this.chunkSize;
    const len = data.byteLength;
    let done = 0;
    while (done < len) {
      const pos = offset + done;
      const index = Math.floor(pos / cs);
      const within = pos - index * cs;
      const n = Math.min(cs - within, len - done);
      let chunk = this.cache.get(index);
      if (!chunk) {
        if (n === cs) {
          chunk = new Uint8Array(cs);
          this.cache.set(index, chunk);
        } else {
          chunk = await this.chunk(index);
        }
      }
      chunk.set(data.subarray(done, done + n), within);
      this.dirty.set(index, (this.dirty.get(index) || 0) + 1);
      done += n;
    }
    this.stats.writes++;
    this.onactivity && this.onactivity("write", len);
  }

  chunk(index) {
    const cached = this.cache.get(index);
    if (cached) {
      return Promise.resolve(cached);
    }
    let pending = this.loading.get(index);
    if (!pending) {
      pending = this.fetchChunk(index).then(chunk => {
        this.loading.delete(index);
        // A full-chunk write may have populated the cache while we were loading.
        const now = this.cache.get(index);
        if (now) {
          return now;
        }
        this.cache.set(index, chunk);
        this.evict();
        return chunk;
      }, err => {
        this.loading.delete(index);
        throw err;
      });
      this.loading.set(index, pending);
    }
    return pending;
  }

  async fetchChunk(index) {
    if (this.overlayKeys.has(index)) {
      const chunk = await this.overlay.get(index);
      if (chunk) {
        this.stats.overlayLoads++;
        return chunk;
      }
    }
    if (this.remote && this.remote.has(index)) {
      this.stats.remoteLoads++;
      return this.remote.get(index);
    }
    if (this.basePresent.has(index)) {
      this.stats.baseLoads++;
      return this.loadBase(index);
    }
    return new Uint8Array(this.chunkSize);
  }

  evict() {
    if (this.cache.size <= this.maxCleanChunks) {
      return;
    }
    for (const index of this.cache.keys()) {
      if (this.cache.size <= this.maxCleanChunks) {
        break;
      }
      if (!this.dirty.has(index)) {
        this.cache.delete(index);
      }
    }
  }

  get dirtyCount() { return this.dirty.size; }

  /** Persists all dirty chunks atomically. Returns the indexes written. */
  async flush() {
    if (!this.dirty.size) {
      return [];
    }
    if (this.flushing) {
      await this.flushing;
      return this.flush();
    }
    const snapshot = new Map(this.dirty);
    const entries = [];
    for (const index of snapshot.keys()) {
      entries.push([index, this.cache.get(index)]);
    }
    // putMany must copy the chunk contents before it first yields.
    this.flushing = this.overlay.putMany(entries);
    try {
      await this.flushing;
    } finally {
      this.flushing = null;
    }
    for (const [index, counter] of snapshot) {
      this.overlayKeys.add(index);
      if (this.dirty.get(index) === counter) {
        this.dirty.delete(index);
      }
    }
    this.stats.flushes++;
    this.evict();
    return [...snapshot.keys()];
  }
}

/** In-memory overlay, used by tests and as a fallback when IndexedDB is unavailable. */
export class MemoryOverlay {
  constructor() { this.map = new Map(); }
  async keys() { return [...this.map.keys()]; }
  async get(i) { const c = this.map.get(i); return c && c.slice(); }
  putMany(entries) {
    for (const [i, chunk] of entries) {
      this.map.set(i, chunk.slice());
    }
    return Promise.resolve();
  }
  async clear() { this.map.clear(); }
}
