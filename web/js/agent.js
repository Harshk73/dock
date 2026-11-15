// Host side of the guest agent protocol (see image/overlay/etc/dock/agent.py).
// Transport-agnostic: give it a function that writes bytes to the guest's second
// serial port, and feed it every byte the guest writes back.

const T = { OPEN: 1, DATA: 2, RESIZE: 3, CLOSE: 4, PING: 5, SYNC: 6, SIGNAL: 7, CONNECT: 8 };
const R = { READY: 65, DATA: 66, EXIT: 67, PONG: 68, SYNCED: 69 };
const HEADER = 7;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class Session {
  constructor(agent, channel) {
    this.agent = agent;
    this.channel = channel;
    this.onData = null; // (Uint8Array) => void
    this.code = null;
    this.exited = new Promise(resolve => { this.resolveExit = resolve; });
  }
  write(data) {
    if (this.code !== null) return;
    const bytes = typeof data === "string" ? encoder.encode(data) : data;
    for (let off = 0; off < bytes.length; off += 4096) {
      this.agent.frame(T.DATA, this.channel, bytes.subarray(off, off + 4096));
    }
  }
  resize(rows, cols) {
    if (this.code !== null) return;
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint16(0, rows, true);
    new DataView(b.buffer).setUint16(2, cols, true);
    this.agent.frame(T.RESIZE, this.channel, b);
  }
  signal(signum) {
    if (this.code === null) this.agent.frame(T.SIGNAL, this.channel, new Uint8Array([signum]));
  }
  /** Asks the process to exit (SIGHUP/SIGTERM, then SIGKILL). */
  close() {
    if (this.code === null) this.agent.frame(T.CLOSE, this.channel, new Uint8Array(0));
  }
}

export class GuestAgent {
  /** @param {(bytes: Uint8Array) => void} send */
  constructor(send) {
    this.send = send;
    this.sessions = new Map();
    this.nextChannel = 1;
    this.waiters = new Map(); // "pong:<nonce>" -> resolve
    this.info = null;
    this.onRestart = null;
    this.ready = new Promise(resolve => { this.markReady = resolve; });
    // receive state
    this.head = new Uint8Array(HEADER);
    this.headLen = 0;
    this.body = null;
    this.bodyLen = 0;
  }

  /** Feed one byte received from the guest. */
  feed(byte) {
    if (this.body === null) {
      this.head[this.headLen++] = byte;
      if (this.headLen < HEADER) return;
      const view = new DataView(this.head.buffer);
      const length = view.getUint32(3, true);
      this.headLen = 0;
      this.kind = this.head[0];
      this.channel = view.getUint16(1, true);
      if (length === 0) {
        this.dispatch(this.kind, this.channel, new Uint8Array(0));
        return;
      }
      this.body = new Uint8Array(length);
      this.bodyLen = 0;
    } else {
      this.body[this.bodyLen++] = byte;
      if (this.bodyLen === this.body.length) {
        const body = this.body;
        this.body = null;
        this.dispatch(this.kind, this.channel, body);
      }
    }
  }

  dispatch(kind, channel, payload) {
    if (kind === R.DATA) {
      const session = this.sessions.get(channel);
      if (session && session.onData) session.onData(payload);
    } else if (kind === R.EXIT) {
      const session = this.sessions.get(channel);
      if (session) {
        this.sessions.delete(channel);
        session.code = new DataView(payload.buffer).getInt32(0, true);
        session.resolveExit(session.code);
      }
    } else if (kind === R.PONG || kind === R.SYNCED) {
      const key = (kind === R.PONG ? "pong:" : "sync:") + decoder.decode(payload);
      const waiter = this.waiters.get(key);
      if (waiter) {
        this.waiters.delete(key);
        waiter();
      }
    } else if (kind === R.READY) {
      // A fresh agent has no sessions; anything we were tracking died with the old one.
      for (const session of this.sessions.values()) {
        session.code = -1;
        session.resolveExit(-1);
      }
      this.sessions.clear();
      const restarted = this.info !== null;
      this.info = JSON.parse(decoder.decode(payload));
      this.markReady();
      if (restarted && this.onRestart) this.onRestart();
    }
  }

  frame(kind, channel, payload) {
    const out = new Uint8Array(HEADER + payload.length);
    const view = new DataView(out.buffer);
    out[0] = kind;
    view.setUint16(1, channel, true);
    view.setUint32(3, payload.length, true);
    out.set(payload, HEADER);
    this.send(out);
  }

  /**
   * Starts a process in the guest.
   * @param {object} spec {script?, argv?, cwd?, env?, rows?, cols?, pty?}
   *   With neither script nor argv, an interactive login shell is started.
   * @returns {Session}
   */
  open(spec = {}, kind = T.OPEN) {
    let channel = this.nextChannel;
    while (this.sessions.has(channel)) channel = channel % 65000 + 1;
    this.nextChannel = channel % 65000 + 1;
    const session = new Session(this, channel);
    this.sessions.set(channel, session);
    this.frame(kind, channel, encoder.encode(JSON.stringify(spec)));
    return session;
  }

  /**
   * Opens a TCP connection to a port inside the guest (for app previews).
   * The returned session's exit code is 0 when the peer closed normally.
   */
  connect(port, host = "127.0.0.1") {
    return this.open({ port, host }, T.CONNECT);
  }

  /** Runs a bash script to completion. @returns {Promise<number>} exit code */
  run(script, onOutput, spec = {}) {
    const session = this.open({ script, ...spec });
    session.onData = onOutput || null;
    return session.exited;
  }

  /** Runs a script without a terminal and returns {code, text}. */
  async capture(script, spec = {}) {
    const parts = [];
    const code = await this.run(script, bytes => parts.push(bytes), { pty: false, ...spec });
    const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let off = 0;
    for (const p of parts) { all.set(p, off); off += p.length; }
    return { code, text: decoder.decode(all) };
  }

  request(kind, prefix, timeoutMs) {
    const nonce = Math.random().toString(36).slice(2);
    const key = prefix + nonce;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(key);
        reject(new Error("guest agent did not answer"));
      }, timeoutMs);
      this.waiters.set(key, () => { clearTimeout(timer); resolve(); });
      this.frame(kind, 0, encoder.encode(nonce));
    });
  }

  ping(timeoutMs = 5000) { return this.request(T.PING, "pong:", timeoutMs); }

  /** Asks the guest to flush filesystem buffers to the virtual disk. */
  sync(timeoutMs = 60000) { return this.request(T.SYNC, "sync:", timeoutMs); }
}
