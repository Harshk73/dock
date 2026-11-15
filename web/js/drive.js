// Google Drive backup of the virtual disk.
//
// The disk's written chunks are stored as gzip files in a "Dock" folder in the user's
// Drive, described by one manifest.json. A backup uploads the chunks that changed,
// then replaces the manifest: until that last step the previous backup stays intact,
// so an interrupted backup never leaves a half-written disk behind.
//
// Sign-in is Google's browser-only OAuth flow (no server, no client secret); it yields
// a one-hour token, and the "drive.file" scope only reaches files Dock itself created.

import { kv, overlay, apps as appStore } from "./store.js";

const SCOPE = "https://www.googleapis.com/auth/drive.file";
const FOLDER = "Dock";

async function gzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function pool(items, size, worker) {
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const i = next++;
      await worker(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, run));
}

export class DriveError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

export class Drive {
  /**
   * @param {object} o
   * @param {() => string} o.clientId
   * @param {() => Promise<void>} o.freeze flush the VM's disk and hold further writes to storage
   * @param {() => void} o.unfreeze
   * @param {{api?: string, auth?: string}} [o.endpoints] overridden in tests
   */
  constructor(o) {
    this.o = o;
    this.api = (o.endpoints && o.endpoints.api) || "https://www.googleapis.com";
    this.auth = (o.endpoints && o.endpoints.auth) || "https://accounts.google.com/o/oauth2/v2/auth";
    this.token = null;
    this.busy = null; // "backup" | "restore" | null
  }

  async init() {
    this.token = await kv.get("drive.token", null);
    await this.consumeRedirect();
  }

  get configured() { return !!this.o.clientId(); }
  get connected() { return !!(this.token && this.token.expiresAt > Date.now() + 30000); }
  get expired() { return !!(this.token && !this.connected); }

  /** Sends the user to Google to grant access; the page comes back with a token. */
  async connect() {
    if (!this.configured) throw new DriveError("Add a Google client ID in Settings first.", "not-configured");
    const state = crypto.randomUUID();
    sessionStorage.setItem("dock.oauth.state", state);
    const params = new URLSearchParams({
      client_id: this.o.clientId(),
      redirect_uri: location.origin + location.pathname,
      response_type: "token",
      scope: SCOPE,
      state,
      include_granted_scopes: "true",
    });
    location.assign(`${this.auth}?${params}`);
  }

  async consumeRedirect() {
    if (!location.hash.includes("access_token=") && !location.hash.includes("error=")) return;
    const params = new URLSearchParams(location.hash.slice(1));
    history.replaceState(null, "", location.pathname + location.search);
    const expected = sessionStorage.getItem("dock.oauth.state");
    sessionStorage.removeItem("dock.oauth.state");
    if (params.get("error")) throw new DriveError("Google sign-in was cancelled.", "denied");
    if (!expected || params.get("state") !== expected) throw new DriveError("Google sign-in could not be verified. Try again.", "state");
    this.token = {
      accessToken: params.get("access_token"),
      expiresAt: Date.now() + Number(params.get("expires_in") || 3600) * 1000,
    };
    await kv.set("drive.token", this.token);
    this.justConnected = true;
  }

  async disconnect() {
    this.token = null;
    await kv.delete("drive.token");
    await kv.delete("drive.folder");
  }

  async call(path, init = {}) {
    if (!this.connected) throw new DriveError("Google Drive needs to be reconnected.", "auth");
    const res = await fetch(this.api + path, {
      ...init,
      headers: { ...(init.headers || {}), authorization: `Bearer ${this.token.accessToken}` },
    });
    if (res.status === 401) {
      this.token = { ...this.token, expiresAt: 0 };
      await kv.set("drive.token", this.token);
      throw new DriveError("Google Drive needs to be reconnected.", "auth");
    }
    if (res.status === 403 || res.status === 507) {
      const text = await res.text();
      if (/storageQuotaExceeded|quota/i.test(text)) throw new DriveError("Your Google storage is full.", "quota");
      throw new DriveError("Google Drive refused the request.", "forbidden");
    }
    if (!res.ok) throw new DriveError(`Google Drive error (${res.status}).`, "http");
    return res;
  }

  async json(path, init) { return (await this.call(path, init)).json(); }

  /** {limit, usage, email} for the storage meter. */
  async about() {
    const info = await this.json("/drive/v3/about?fields=storageQuota,user(emailAddress)");
    return {
      limit: Number(info.storageQuota.limit || 0),
      usage: Number(info.storageQuota.usage || 0),
      email: info.user ? info.user.emailAddress : "",
    };
  }

  async folder() {
    const saved = await kv.get("drive.folder", null);
    if (saved) return saved;
    const query = encodeURIComponent(`name='${FOLDER}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
    const found = await this.json(`/drive/v3/files?q=${query}&fields=files(id)&spaces=drive`);
    let id = found.files && found.files[0] && found.files[0].id;
    if (!id) {
      const created = await this.json("/drive/v3/files?fields=id", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: FOLDER, mimeType: "application/vnd.google-apps.folder" }),
      });
      id = created.id;
    }
    await kv.set("drive.folder", id);
    return id;
  }

  async list(folder) {
    const files = [];
    let page = "";
    do {
      const query = encodeURIComponent(`'${folder}' in parents and trashed=false`);
      const res = await this.json(`/drive/v3/files?q=${query}&fields=nextPageToken,files(id,name)&pageSize=1000${page ? `&pageToken=${page}` : ""}`);
      files.push(...(res.files || []));
      page = res.nextPageToken || "";
    } while (page);
    return files;
  }

  async upload(folder, name, bytes, type) {
    const boundary = "dock" + crypto.randomUUID().replace(/-/g, "");
    const meta = JSON.stringify({ name, parents: [folder] });
    const body = new Blob([
      `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`,
      `--${boundary}\r\ncontent-type: ${type}\r\n\r\n`, bytes, `\r\n--${boundary}--`,
    ]);
    const res = await this.json("/upload/drive/v3/files?uploadType=multipart&fields=id", {
      method: "POST",
      headers: { "content-type": `multipart/related; boundary=${boundary}` },
      body,
    });
    return res.id;
  }

  async download(id) {
    return new Uint8Array(await (await this.call(`/drive/v3/files/${id}?alt=media`)).arrayBuffer());
  }

  async remove(id) {
    try { await this.call(`/drive/v3/files/${id}`, { method: "DELETE" }); } catch { /* cleaned up next time */ }
  }

  /** The backup's manifest, or null when Drive holds no backup. */
  async remoteManifest() {
    const folder = await this.folder();
    const files = await this.list(folder);
    const entry = files.find(f => f.name === "manifest.json");
    if (!entry) return { folder, files, entry: null, manifest: null };
    const manifest = JSON.parse(new TextDecoder().decode(await this.download(entry.id)));
    return { folder, files, entry, manifest };
  }

  /**
   * Uploads what changed since the last backup.
   * @param {{force?: boolean, onProgress?: (done: number, total: number) => void}} [options]
   *   force: replace a backup that belongs to another phone or disk.
   */
  async backup(options = {}) {
    if (this.busy) throw new DriveError("A backup is already running.", "busy");
    this.busy = "backup";
    let frozen = false;
    try {
      const { folder, files, entry, manifest: remote } = await this.remoteManifest();
      const diskId = await kv.get("disk.id");
      const baseVersion = await kv.get("disk.baseVersion");
      const lastGeneration = await kv.get("backup.generation", 0);
      const sameDisk = remote && remote.diskId === diskId && remote.baseVersion === baseVersion;
      if (remote && !options.force && (!sameDisk || remote.generation !== lastGeneration)) {
        throw new DriveError("Google Drive holds a backup from another phone or an older copy of this disk.", "conflict");
      }
      await this.o.freeze();
      frozen = true;
      // Starting a new lineage: every written chunk has to go up.
      const pending = sameDisk && remote.generation === lastGeneration
        ? await kv.get("backup.pending", [])
        : await overlay.keys();
      const generation = (remote ? remote.generation : 0) + 1;
      const chunks = sameDisk && remote.generation === lastGeneration ? { ...remote.chunks } : {};
      const replaced = [];
      let doneCount = 0;
      if (options.onProgress) options.onProgress(0, pending.length);
      await pool(pending, 4, async index => {
        const chunk = await overlay.get(index);
        if (chunk) {
          const id = await this.upload(folder, `c${index}-g${generation}.gz`, await gzip(chunk), "application/gzip");
          if (chunks[index]) replaced.push(chunks[index]);
          chunks[index] = id;
        }
        if (options.onProgress) options.onProgress(++doneCount, pending.length);
      });
      const manifest = {
        format: 1, diskId, baseVersion, generation, updatedAt: Date.now(),
        chunkSize: 1 << 20, chunks, apps: await appStore.all(),
      };
      const body = JSON.stringify(manifest);
      if (entry) {
        await this.call(`/upload/drive/v3/files/${entry.id}?uploadType=media`, {
          method: "PATCH", headers: { "content-type": "application/json" }, body,
        });
      } else {
        await this.upload(folder, "manifest.json", body, "application/json");
      }
      // The new backup is now the truth.
      await kv.set("backup.generation", generation);
      await kv.set("backup.pending", []);
      await kv.set("backup.last", Date.now());
      await kv.set("backup.chunks", Object.keys(chunks).length);
      // Tidy up: chunk files the new manifest no longer refers to.
      const live = new Set(Object.values(chunks));
      const stale = files.filter(f => f.name !== "manifest.json" && !live.has(f.id)).map(f => f.id);
      await pool([...new Set([...replaced, ...stale])], 4, id => this.remove(id));
      return { uploaded: pending.length, generation };
    } finally {
      if (frozen) this.o.unfreeze();
      this.busy = null;
    }
  }

  /**
   * Replaces this phone's disk with the Drive backup. The VM must be stopped first.
   * @param {{expectedBaseVersion: string, onProgress?: (done: number, total: number) => void}} options
   */
  async restore(options) {
    if (this.busy) throw new DriveError("A backup is already running.", "busy");
    this.busy = "restore";
    try {
      const { manifest } = await this.remoteManifest();
      if (!manifest) throw new DriveError("There is no Dock backup in this Google Drive.", "empty");
      if (manifest.baseVersion !== options.expectedBaseVersion) {
        throw new DriveError("That backup was made with a different version of Dock's system image and can't be restored here.", "version");
      }
      await kv.set("restore.inProgress", true);
      await overlay.clear();
      const entries = Object.entries(manifest.chunks);
      let doneCount = 0;
      if (options.onProgress) options.onProgress(0, entries.length);
      await pool(entries, 4, async ([index, id]) => {
        const chunk = await gunzip(await this.download(id));
        await overlay.putMany([[Number(index), chunk]], { markPending: false });
        if (options.onProgress) options.onProgress(++doneCount, entries.length);
      });
      await appStore.replaceAll(manifest.apps || []);
      await kv.set("disk.id", manifest.diskId);
      await kv.set("disk.baseVersion", manifest.baseVersion);
      await kv.set("backup.generation", manifest.generation);
      await kv.set("backup.pending", []);
      await kv.set("backup.last", manifest.updatedAt);
      await kv.set("backup.chunks", entries.length);
      await kv.delete("restore.inProgress");
      return { chunks: entries.length };
    } finally {
      this.busy = null;
    }
  }
}
