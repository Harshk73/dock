// Boots and owns the emulator. Works in the browser and (for tests) in Node.

import { GuestAgent } from "./agent.js";

const DOH_HOST = "dock-relay.invalid";
let dohTarget = null;

// The emulator resolves the guest's DNS queries with fetch("https://<doh_server>/dns-query").
// Point that at the relay, whatever scheme and path it lives on.
function installDnsRedirect() {
  if (globalThis.__dockDnsRedirect) return;
  globalThis.__dockDnsRedirect = true;
  const realFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (input, init) => {
    if (typeof input === "string" && input === `https://${DOH_HOST}/dns-query` && dohTarget) {
      return realFetch(dohTarget, init);
    }
    return realFetch(input, init);
  };
}

/**
 * @param {object} o
 * @param {Function} o.V86 emulator constructor
 * @param {string} o.wasmPath
 * @param {object} o.files {bios, vgaBios, kernel, initrd} urls (or paths in Node)
 * @param {string} o.cmdline
 * @param {object} o.disk ChunkDisk
 * @param {number} o.memoryMB
 * @param {string|null} o.relayBase http(s) base of the relay, e.g. "https://host/r/open"
 */
export class Machine {
  constructor(o) {
    this.o = o;
    this.listeners = { console: new Set(), state: new Set() };
    this.state = "off"; // off | booting | ready | stopped
    this.flowControl = false;
    this.emulator = null;
    this.agent = null;
  }

  on(event, fn) {
    this.listeners[event].add(fn);
    return () => this.listeners[event].delete(fn);
  }

  setState(state) {
    this.state = state;
    for (const fn of this.listeners.state) fn(state);
  }

  async boot() {
    const o = this.o;
    this.setState("booting");
    let netDevice;
    if (o.relayBase) {
      installDnsRedirect();
      dohTarget = o.relayBase + "/dns-query";
      try {
        const info = await (await fetch(o.relayBase + "/info")).json();
        this.flowControl = !!info.flowControl;
      } catch {
        this.flowControl = false;
      }
      netDevice = {
        type: "virtio",
        relay_url: o.relayBase.replace(/^http/, "wisp") + "/wisp/",
        dns_method: "doh",
        doh_server: DOH_HOST,
      };
    }
    const emulator = this.emulator = new o.V86({
      wasm_path: o.wasmPath,
      memory_size: o.memoryMB * 1024 * 1024,
      vga_memory_size: 2 * 1024 * 1024,
      bios: { url: o.files.bios },
      vga_bios: { url: o.files.vgaBios },
      bzimage: { url: o.files.kernel },
      initrd: { url: o.files.initrd },
      cmdline: o.cmdline,
      hda: o.disk,
      uart1: true,
      net_device: netDevice,
      disable_speaker: true,
      autostart: true,
    });
    this.agent = new GuestAgent(bytes => emulator.serial_send_bytes(1, bytes));
    emulator.add_listener("serial1-output-byte", byte => this.agent.feed(byte));

    // Console output is batched: one event per byte is far too chatty for a terminal.
    let pending = [];
    let timer = null;
    const flush = () => {
      timer = null;
      const bytes = new Uint8Array(pending);
      pending = [];
      for (const fn of this.listeners.console) fn(bytes);
    };
    emulator.add_listener("serial0-output-byte", byte => {
      pending.push(byte);
      if (!timer) timer = setTimeout(flush, 8);
    });

    await this.agent.ready;
    if (netDevice && this.flowControl) this.startFlowControl();
    this.setState("ready");
  }

  /** Sends keystrokes to the guest console. */
  type(bytes) {
    if (this.emulator) this.emulator.serial_send_bytes(0, bytes);
  }

  // The relay can deliver data much faster than the emulated guest consumes it; without
  // back-pressure a large download would pile up in page memory. Tell the relay to pause
  // a stream while the guest-side TCP buffer is long. (Relay-specific extension.)
  startFlowControl() {
    const HIGH = 1 << 20, LOW = 256 << 10;
    const adapter = this.emulator.network_adapter;
    const paused = new Set();
    const signal = (type, id) => {
      const frame = new Uint8Array(5);
      frame[0] = type;
      new DataView(frame.buffer).setUint32(1, id, true);
      if (adapter.wispws && adapter.wispws.readyState === 1) adapter.wispws.send(frame);
    };
    this.flowTimer = setInterval(() => {
      const live = new Set();
      for (const key in adapter.tcp_conn) {
        const conn = adapter.tcp_conn[key];
        if (conn.stream_id === undefined || !conn.send_buffer) continue;
        live.add(conn.stream_id);
        const queued = conn.send_buffer.length;
        if (!paused.has(conn.stream_id) && queued > HIGH) {
          paused.add(conn.stream_id);
          signal(0x11, conn.stream_id);
        } else if (paused.has(conn.stream_id) && queued < LOW) {
          paused.delete(conn.stream_id);
          signal(0x12, conn.stream_id);
        }
      }
      for (const id of paused) if (!live.has(id)) paused.delete(id);
    }, 40);
  }

  /** Flushes guest buffers and persists the disk. */
  async save() {
    if (this.state === "ready") {
      await this.agent.sync().catch(() => {});
    }
    return this.o.disk.flush();
  }

  async stop() {
    clearInterval(this.flowTimer);
    if (this.emulator) {
      await this.save().catch(() => {});
      await this.emulator.destroy();
      this.emulator = null;
    }
    this.setState("stopped");
  }
}
