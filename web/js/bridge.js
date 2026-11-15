// A tiny HTTP endpoint that exists only inside the page. The VM's virtual network card
// delivers connections for http://192.168.86.1/ here instead of to the relay, which
// gives a much faster path for moving files in and out of the VM than the serial port.
//
//   GET /pull/<token>   the VM downloads bytes the page registered with offer()
//   PUT /push/<token>   the VM uploads a file to a sink the page registered with expect()

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function findHeadEnd(bytes) {
  for (let i = 0; i + 3 < bytes.length; i++) {
    if (bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 && bytes[i + 3] === 10) return i;
  }
  return -1;
}

export class HostBridge {
  /** @param {object} adapter the emulator's network adapter (fake TCP stack) */
  constructor(adapter) {
    this.adapter = adapter;
    this.host = adapter.router_ip.join(".");
    this.offers = new Map(); // token -> {bytes, onProgress}
    this.sinks = new Map(); // token -> {onChunk, onProgress, resolve, reject}
    const forward = adapter.on_tcp_connection.bind(adapter);
    adapter.on_tcp_connection = (conn, packet) => {
      if (conn.sport === 80 && packet.ipv4.dest.join(".") === this.host) {
        this.serve(conn);
        conn.accept();
        return true;
      }
      return forward(conn, packet);
    };
  }

  token() {
    return Array.from(crypto.getRandomValues(new Uint8Array(12)), b => b.toString(16).padStart(2, "0")).join("");
  }

  /** Makes bytes downloadable by the VM once. Returns the URL to fetch inside the VM. */
  offer(bytes, onProgress) {
    const token = this.token();
    this.offers.set(token, { bytes, onProgress });
    return `http://${this.host}/pull/${token}`;
  }

  /**
   * Prepares to receive an upload from the VM.
   * @returns {{url: string, done: Promise<Uint8Array>}}
   */
  expect(onProgress) {
    const token = this.token();
    const parts = [];
    let resolve, reject;
    const done = new Promise((res, rej) => { resolve = res; reject = rej; });
    this.sinks.set(token, { parts, onProgress, resolve, reject });
    return { url: `http://${this.host}/push/${token}`, done, cancel: () => { this.sinks.delete(token); reject(new Error("cancelled")); } };
  }

  serve(conn) {
    let head = new Uint8Array(0);
    let sink = null;
    let remaining = 0;
    let received = 0;
    let total = 0;
    const respond = (status, body = "") => {
      conn.write(encoder.encode(`HTTP/1.1 ${status}\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`));
      conn.close();
    };
    const finishUpload = () => {
      const out = new Uint8Array(received);
      let off = 0;
      for (const p of sink.parts) { out.set(p, off); off += p.length; }
      sink.resolve(out);
      sink = null;
      respond("200 OK", "ok");
    };
    const takeBody = chunk => {
      if (!chunk.length) return;
      const part = chunk.length > remaining ? chunk.slice(0, remaining) : chunk.slice();
      sink.parts.push(part);
      received += part.length;
      remaining -= part.length;
      if (sink.onProgress) sink.onProgress(received, total);
      if (remaining <= 0) finishUpload();
    };
    conn.on_close = () => { if (sink) { sink.reject(new Error("The transfer was interrupted.")); sink = null; } };
    conn.on_shutdown = conn.on_close;
    conn.on("data", chunk => {
      if (sink) return takeBody(chunk);
      if (head === null) return;
      const joined = new Uint8Array(head.length + chunk.length);
      joined.set(head);
      joined.set(chunk, head.length);
      head = joined;
      const end = findHeadEnd(head);
      if (end < 0) return;
      const lines = decoder.decode(head.subarray(0, end)).split("\r\n");
      const rest = head.subarray(end + 4);
      head = null;
      const [method, path] = lines[0].split(" ");
      const length = Number((lines.find(l => /^content-length:/i.test(l)) || "").split(":")[1] || 0);
      const pull = path.match(/^\/pull\/([0-9a-f]+)$/);
      const push = path.match(/^\/push\/([0-9a-f]+)$/);
      if (method === "GET" && pull && this.offers.has(pull[1])) {
        const offer = this.offers.get(pull[1]);
        this.offers.delete(pull[1]);
        this.sendBody(conn, offer);
      } else if (method === "PUT" && push && this.sinks.has(push[1])) {
        sink = this.sinks.get(push[1]);
        this.sinks.delete(push[1]);
        remaining = total = length;
        if (!length) return finishUpload();
        takeBody(rest);
      } else {
        respond("404 Not Found");
      }
    });
  }

  // Feed the body in slices so a large file is not copied into the TCP buffer at once.
  sendBody(conn, { bytes, onProgress }) {
    conn.write(encoder.encode(`HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: ${bytes.length}\r\nConnection: close\r\n\r\n`));
    let offset = 0;
    const SLICE = 256 * 1024;
    const pump = () => {
      if (conn.state === "closed") return;
      while (offset < bytes.length && conn.send_buffer.length < 2 * SLICE) {
        conn.write(bytes.subarray(offset, offset + SLICE));
        offset += SLICE;
      }
      if (onProgress) onProgress(Math.max(0, Math.min(bytes.length, offset) - conn.send_buffer.length), bytes.length);
      if (offset < bytes.length || conn.send_buffer.length) setTimeout(pump, 15);
      else conn.close();
    };
    pump();
  }
}
