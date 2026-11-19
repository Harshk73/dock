// Test helper: boots the Dock VM in Node (no browser) against a local relay.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { V86 } from "v86";
import { ChunkDisk, MemoryOverlay } from "../web/js/disk.js";
import { Machine } from "../web/js/machine.js";
import { createRelay } from "../server/relay.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const VM = path.join(ROOT, "web", "vm");

/** An overlay kept in a directory, so slow setup (installs) can be reused across test runs. */
export class DirOverlay {
  constructor(dir) { this.dir = dir; fs.mkdirSync(dir, { recursive: true }); }
  async keys() { return fs.readdirSync(this.dir).map(Number); }
  async get(i) { const f = path.join(this.dir, String(i)); return fs.existsSync(f) ? new Uint8Array(fs.readFileSync(f)) : undefined; }
  putMany(entries) { for (const [i, chunk] of entries) fs.writeFileSync(path.join(this.dir, String(i)), chunk); return Promise.resolve(); }
}

export async function startVm({ overlay = new MemoryOverlay(), memoryMB = 512, echo = false, loadBase = null, stallMs = undefined } = {}) {
  // In the build sandbox every outbound connection must go through its HTTPS proxy.
  const upstream = process.env.HTTPS_PROXY ? new URL(process.env.HTTPS_PROXY) : null;
  const relay = createRelay({
    log: () => {},
    proxy: upstream ? { host: upstream.hostname, port: Number(upstream.port), noProxy: [] } : null,
  });
  await new Promise(r => relay.server.listen(0, "127.0.0.1", r));
  const port = relay.server.address().port;
  const manifest = JSON.parse(fs.readFileSync(path.join(VM, "disk", "manifest.json")));
  const disk = new ChunkDisk({
    size: manifest.size,
    chunkSize: manifest.chunkSize,
    basePresent: manifest.present,
    loadBase: loadBase || (async i => new Uint8Array(zlib.gunzipSync(fs.readFileSync(path.join(VM, "disk", `${i}.gz`))))),
    overlay,
    maxCleanChunks: 400,
  });
  const machine = new Machine({
    V86,
    wasmPath: path.join(ROOT, "node_modules", "v86", "build", "v86.wasm"),
    files: {
      bios: path.join(VM, "bios", "seabios.bin"),
      vgaBios: path.join(VM, "bios", "vgabios.bin"),
      kernel: path.join(VM, manifest.kernel),
      initrd: path.join(VM, manifest.initrd),
    },
    cmdline: manifest.cmdline,
    disk,
    memoryMB,
    stallMs,
    relayBase: `http://127.0.0.1:${port}${relay.prefix}`,
  });
  let consoleText = "";
  machine.on("console", bytes => {
    const text = Buffer.from(bytes).toString();
    consoleText += text;
    if (echo) process.stdout.write(text);
  });
  const started = Date.now();
  await machine.boot();
  return {
    machine, disk, overlay, relay,
    bootMs: Date.now() - started,
    console: () => consoleText,
    async sh(script, { echo: echoJob = false, pty = false } = {}) {
      const t = Date.now();
      const out = [];
      const code = await machine.agent.run(script, bytes => {
        out.push(Buffer.from(bytes));
        if (echoJob) process.stdout.write(Buffer.from(bytes));
      }, { pty });
      return { code, text: Buffer.concat(out).toString(), ms: Date.now() - t };
    },
    async stop() {
      await machine.stop();
      relay.server.closeAllConnections();
      await new Promise(r => relay.server.close(r));
    },
  };
}
