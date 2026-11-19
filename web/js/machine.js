// Boots and owns the emulator. Works in the browser and (for tests) in Node.

import { GuestAgent } from "./agent.js";
import { HostBridge } from "./bridge.js";

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

const STALL_MS = 120000; // no sign of progress for this long means start-up is stuck
const BOOT_LIMIT_MS = 15 * 60000;
const MEMORY_ERROR = /memory|typed array length|array buffer allocation|out of bounds|allocation failed|unreachable/i;

/** Why start-up failed. code: memory | unsupported | download | guest | stalled | crash */
export class BootError extends Error {
  constructor(code, message, { stage = "", cause = null } = {}) {
    super(message);
    this.name = "BootError";
    this.code = code;
    this.stage = stage;
    this.cause = cause;
  }
}

function asBootError(err, stage) {
  if (err instanceof BootError) return err;
  const message = String((err && err.message) || err || "unknown error");
  if ((err && err.name === "RangeError") || MEMORY_ERROR.test(message)) {
    return new BootError("memory", "This device couldn't give Linux enough memory.", { stage, cause: err });
  }
  return new BootError("crash", `The emulator stopped with an error: ${message}`, { stage, cause: err });
}

/** Checks that this browser can run the emulator at all. Throws BootError if not. */
export function checkBrowserSupport(g = globalThis) {
  if (typeof g.WebAssembly === "undefined") {
    throw new BootError("unsupported", "This browser has WebAssembly turned off, which Dock needs. On iPhone this is usually Lockdown Mode: Settings → Privacy & Security → Lockdown Mode → Configure Web Browsing, and exclude this site.");
  }
  if (typeof g.DecompressionStream === "undefined") {
    throw new BootError("unsupported", "Dock needs a newer browser. On iPhone, update to iOS 16.4 or later.");
  }
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
    this.listeners = { console: new Set(), state: new Set(), progress: new Set() };
    // What start-up is doing, for the UI and for diagnostics.
    this.progress = { stage: "off", detail: "", percent: null, startedAt: 0, readyAt: 0, log: "", errors: [] };
    this.state = "off"; // off | booting | ready | stopped
    this.flowControl = false;
    this.emulator = null;
    this.agent = null;
    this.bridge = null; // fast file transfer between page and VM (see bridge.js)
  }

  on(event, fn) {
    this.listeners[event].add(fn);
    return () => this.listeners[event].delete(fn);
  }

  setState(state) {
    this.state = state;
    for (const fn of this.listeners.state) fn(state);
  }

  report(stage, detail = "", percent = null) {
    Object.assign(this.progress, { stage, detail, percent });
    for (const fn of this.listeners.progress) fn(this.progress);
  }

  /**
   * Starts Linux. Resolves once the guest agent answers; rejects with a BootError
   * instead of waiting forever when start-up crashes or stops making progress.
   */
  async boot() {
    const o = this.o;
    this.setState("booting");
    Object.assign(this.progress, { startedAt: Date.now(), readyAt: 0, log: "", errors: [] });
    this.report("connect", "Connecting to the network relay");
    checkBrowserSupport();

    let rejectBoot;
    const failed = new Promise((_, reject) => { rejectBoot = reject; });
    failed.catch(() => {});
    let done = false;
    const fail = err => {
      if (done) return;
      done = true;
      rejectBoot(asBootError(err, this.progress.stage));
    };
    const cleanups = [];

    // The emulator does much of its start-up in callbacks; an exception there would
    // otherwise vanish and leave us waiting forever.
    if (typeof globalThis.addEventListener === "function") {
      const fromEmulator = err => {
        const text = `${err && err.message} ${err && err.stack}`;
        return /v86|libv86|wasm/i.test(text) || MEMORY_ERROR.test(String(err && err.message)) || (err && err.name === "RangeError");
      };
      const onError = e => {
        const err = e.error || new Error(e.message);
        this.progress.errors.push(String(err && err.message));
        if (fromEmulator(err)) fail(err);
      };
      const onRejection = e => {
        this.progress.errors.push(String(e.reason && e.reason.message || e.reason));
        if (fromEmulator(e.reason)) fail(e.reason);
      };
      globalThis.addEventListener("error", onError);
      globalThis.addEventListener("unhandledrejection", onRejection);
      cleanups.push(() => {
        globalThis.removeEventListener("error", onError);
        globalThis.removeEventListener("unhandledrejection", onRejection);
      });
    }
    o.disk.onerror = err => fail(new BootError("download", "Part of Linux's disk couldn't be downloaded. Check your connection and try again.", { stage: this.progress.stage, cause: err }));

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
    this.report("download", "Downloading the emulator", 0);
    let emulator;
    try {
      emulator = this.emulator = new o.V86({
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
    } catch (err) {
      throw asBootError(err, "download");
    }
    this.agent = new GuestAgent(bytes => emulator.serial_send_bytes(1, bytes));
    emulator.add_listener("serial1-output-byte", byte => this.agent.feed(byte));

    // Progress signals: downloads, the CPU's instruction counter, disk reads, console output.
    let downloaded = 0;
    emulator.add_listener("download-progress", e => {
      downloaded = e.loaded + e.file_index * 1e9;
      if (this.progress.stage !== "download") return;
      const part = e.lengthComputable && e.total ? e.loaded / e.total : 0;
      const percent = Math.round(((e.file_index + part) / Math.max(1, e.file_count)) * 100);
      this.report("download", /wasm/.test(e.file_name) ? "Downloading the emulator" : "Downloading Linux", percent);
    });
    emulator.add_listener("download-error", e => fail(new BootError("download", `Couldn't download ${String(e.file_name).split("/").pop().split("?")[0]}. Check your connection and try again.`, { stage: "download" })));
    emulator.add_listener("emulator-started", () => this.report("kernel", "Starting the Linux kernel"));

    // Console output is batched: one event per byte is far too chatty for a terminal.
    let pending = [];
    let timer = null;
    let consoleBytes = 0;
    const decoder = new TextDecoder();
    const flush = () => {
      timer = null;
      const bytes = new Uint8Array(pending);
      pending = [];
      if (!done || this.state === "ready") {
        this.progress.log = (this.progress.log + decoder.decode(bytes, { stream: true })).slice(-8000);
        const log = this.progress.log;
        if (/Kernel panic/.test(log)) fail(new BootError("guest", "Linux crashed while starting (kernel panic).", { stage: this.progress.stage }));
        else if (/dock: cannot mount the root disk/.test(log)) fail(new BootError("guest", "Linux couldn't open its disk.", { stage: this.progress.stage }));
        else if (this.progress.stage !== "services" && /login\[|Dock Linux/.test(log)) this.report("services", "Starting Dock's services");
      }
      for (const fn of this.listeners.console) fn(bytes);
    };
    emulator.add_listener("serial0-output-byte", byte => {
      pending.push(byte);
      consoleBytes++;
      if (!timer) timer = setTimeout(flush, 8);
    });

    // Watchdog. Time the page spends hidden (phone locked, app in the background) doesn't
    // count: the browser pauses everything then.
    let lastSignature = "";
    let lastChange = Date.now();
    let lastTick = Date.now();
    let activeMs = 0;
    const watchdog = setInterval(() => {
      const now = Date.now();
      const gap = now - lastTick;
      lastTick = now;
      if (gap > 15000) { lastChange = now; return; }
      activeMs += gap;
      // The CPU keeps ticking while it waits for a disk read, so it only counts as
      // progress when no read is outstanding: a download that hangs is a stall.
      let instructions = 0;
      const waitingForDisk = o.disk.loading && o.disk.loading.size > 0;
      if (!waitingForDisk) {
        try { instructions = emulator.get_instruction_counter(); } catch { /* not started yet */ }
      }
      const reads = o.disk.stats ? o.disk.stats.baseLoads + o.disk.stats.overlayLoads : 0;
      if (this.progress.stage === "kernel" && reads > 2) this.report("disk", "Reading Linux's disk", null);
      if (this.progress.stage === "disk" || this.progress.stage === "services") this.progress.detail = `${this.progress.stage === "disk" ? "Reading Linux's disk" : "Starting Dock's services"} · ${reads} MB loaded`;
      const signature = `${downloaded}/${waitingForDisk ? "wait" : instructions}/${reads}/${consoleBytes}`;
      if (signature !== lastSignature) { lastSignature = signature; lastChange = now; }
      if (now - lastChange > (o.stallMs || STALL_MS)) {
        fail(waitingForDisk
          ? new BootError("download", "Linux's disk stopped downloading. Check your connection and try again.", { stage: this.progress.stage })
          : new BootError("stalled", "Linux stopped making progress while starting.", { stage: this.progress.stage }));
      } else if (activeMs > BOOT_LIMIT_MS) {
        fail(new BootError("stalled", "Linux is taking far too long to start.", { stage: this.progress.stage }));
      }
    }, 3000);
    cleanups.push(() => clearInterval(watchdog));

    try {
      await Promise.race([this.agent.ready, failed]);
    } finally {
      done = true;
      for (const cleanup of cleanups) cleanup();
    }
    this.progress.readyAt = Date.now();
    this.report("ready", "");
    this.bridge = netDevice ? new HostBridge(emulator.network_adapter) : null;
    if (netDevice && this.flowControl) this.startFlowControl();
    this.setState("ready");
  }

  /** Frees the emulator after a failed start, ignoring errors from a half-built one. */
  async discard() {
    clearInterval(this.flowTimer);
    const emulator = this.emulator;
    this.emulator = null;
    if (emulator) {
      try { await emulator.destroy(); } catch { /* it never finished starting */ }
    }
    this.setState("stopped");
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
