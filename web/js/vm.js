// Assembles the VM in the browser: base image from the app's static files, written
// chunks in IndexedDB, emulator from web/vendor.

import { V86 } from "../vendor/libv86.mjs";
import { ChunkDisk } from "./disk.js";
import { Machine, checkBrowserSupport } from "./machine.js";
import { overlay, kv } from "./store.js";

async function gunzip(bytes) {
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes; // the host already decoded it
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// System-image files are cached aggressively (service worker + HTTP cache), so their
// URLs carry the image version: a new image can never be mixed with cached old chunks.
async function loadBaseChunk(index, version) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`vm/disk/${index}.gz?v=${version}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await gunzip(new Uint8Array(await res.arrayBuffer()));
    } catch (err) {
      if (attempt >= 4) throw err;
      await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
    }
  }
}

async function pruneImageCache(version) {
  try {
    const cache = await caches.open("dock-vm-v1");
    for (const request of await cache.keys()) {
      if (!request.url.includes(`v=${version}`)) cache.delete(request);
    }
  } catch { /* Cache Storage unavailable */ }
}

export class BaseChangedError extends Error {
  constructor() {
    super("The system image was updated and no longer matches the saved disk.");
    this.code = "base-changed";
  }
}

/**
 * @param {{relayBase: string|null, memoryMB: number}} settings
 * @returns {Promise<{machine: Machine, disk: ChunkDisk, manifest: object}>}
 */
export async function createVm(settings) {
  checkBrowserSupport();
  const manifest = await (await fetch("vm/disk/manifest.json", { cache: "no-cache" })).json();
  const savedVersion = await kv.get("disk.baseVersion");
  if (savedVersion && savedVersion !== manifest.version && await overlay.count()) {
    throw new BaseChangedError();
  }
  await kv.set("disk.baseVersion", manifest.version);
  pruneImageCache(manifest.version);

  const disk = new ChunkDisk({
    size: manifest.size,
    chunkSize: manifest.chunkSize,
    basePresent: manifest.present,
    loadBase: index => loadBaseChunk(index, manifest.version),
    overlay,
    maxCleanChunks: 72,
  });
  const machine = new Machine({
    V86,
    wasmPath: "vendor/v86.wasm",
    files: {
      bios: "vm/bios/seabios.bin",
      vgaBios: "vm/bios/vgabios.bin",
      kernel: `vm/${manifest.kernel}?v=${manifest.version}`,
      initrd: `vm/${manifest.initrd}?v=${manifest.version}`,
    },
    cmdline: manifest.cmdline,
    disk,
    memoryMB: settings.memoryMB,
    relayBase: settings.relayBase,
  });
  return { machine, disk, manifest };
}
