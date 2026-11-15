// Dock relay: gives the in-browser Linux VM access to the internet.
//
// A browser cannot open raw TCP sockets, so the VM's network card is wired to this
// server over one WebSocket (WISP v1 framing). The relay also answers the VM's DNS
// queries: every hostname gets a placeholder address from 198.18.0.0/15, and when
// the VM then connects to that address the relay connects to the real hostname.
// That keeps DNS on the relay, lets it refuse private-network targets, and lets it
// run behind an outbound HTTP proxy.
//
// Endpoints (TOKEN is DOCK_TOKEN, or "open" when unset):
//   GET  /r/TOKEN/info        -> {"dock": 1, ...}
//   POST /r/TOKEN/dns-query   -> DNS-over-HTTPS wire format
//   WS   /r/TOKEN/wisp/       -> WISP v1 (+ PAUSE/RESUME extension packets 0x11/0x12)
// Everything else is served from ../web as static files.

import http from "node:http";
import net from "node:net";
import dns from "node:dns/promises";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".webmanifest": "application/manifest+json",
  ".wasm": "application/wasm", ".png": "image/png", ".svg": "image/svg+xml",
  ".ico": "image/x-icon", ".gz": "application/octet-stream", ".bin": "application/octet-stream",
  ".txt": "text/plain; charset=utf-8", ".woff2": "font/woff2",
};

const WISP = { CONNECT: 1, DATA: 2, CONTINUE: 3, CLOSE: 4, PAUSE: 0x11, RESUME: 0x12 };
const STREAM_BUFFER = 128; // DATA packets the client may send per stream before a CONTINUE

function isPrivateV4(ip) {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some(n => !(n >= 0 && n <= 255))) return true;
  return p[0] === 0 || p[0] === 10 || p[0] === 127 || (p[0] === 100 && p[1] >= 64 && p[1] <= 127) ||
    (p[0] === 169 && p[1] === 254) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 192 && p[1] === 168) || (p[0] === 198 && (p[1] === 18 || p[1] === 19)) || p[0] >= 224;
}

function isPrivateAddress(address) {
  if (net.isIPv4(address)) return isPrivateV4(address);
  const a = address.toLowerCase();
  if (a.startsWith("::ffff:")) return isPrivateV4(a.slice(7));
  return a === "::1" || a === "::" || a.startsWith("fc") || a.startsWith("fd") || a.startsWith("fe80");
}

/** Hands out placeholder IPv4 addresses for hostnames and maps them back. */
class NameTable {
  constructor(limit = 60000) {
    this.limit = limit;
    this.byName = new Map();
    this.byIp = new Map();
    this.next = 1;
  }
  ipFor(name) {
    name = name.toLowerCase();
    let ip = this.byName.get(name);
    if (ip) return ip;
    const n = this.next;
    this.next = this.next % this.limit + 1;
    ip = `198.${18 + (n >> 16)}.${(n >> 8) & 255}.${n & 255}`;
    const old = this.byIp.get(ip);
    if (old) this.byName.delete(old);
    this.byName.set(name, ip);
    this.byIp.set(ip, name);
    return ip;
  }
  nameFor(ip) { return this.byIp.get(ip); }
}

function parseDnsQuestion(msg) {
  if (msg.length < 17) return null;
  let off = 12;
  const labels = [];
  while (off < msg.length) {
    const len = msg[off++];
    if (len === 0) break;
    if (len > 63 || off + len > msg.length) return null;
    labels.push(msg.subarray(off, off + len).toString("latin1"));
    off += len;
  }
  if (off + 4 > msg.length) return null;
  return { name: labels.join("."), type: msg.readUInt16BE(off), end: off + 4 };
}

function dnsReply(query, q, { rcode = 0, address = null }) {
  const head = Buffer.from(query.subarray(0, q.end));
  head.writeUInt16BE(0x8180 | rcode, 2); // response, recursion desired + available
  head.writeUInt16BE(1, 4);
  head.writeUInt16BE(address ? 1 : 0, 6);
  head.writeUInt16BE(0, 8);
  head.writeUInt16BE(0, 10);
  if (!address) return head;
  const answer = Buffer.alloc(16);
  answer.writeUInt16BE(0xc00c, 0); // pointer to the question name
  answer.writeUInt16BE(1, 2); // A
  answer.writeUInt16BE(1, 4); // IN
  answer.writeUInt32BE(5, 6); // TTL
  answer.writeUInt16BE(4, 10);
  address.split(".").forEach((n, i) => answer.writeUInt8(Number(n), 12 + i));
  return Buffer.concat([head, answer]);
}

function parseProxy(env) {
  const raw = env.DOCK_UPSTREAM_PROXY ?? env.HTTPS_PROXY ?? env.https_proxy ?? "";
  if (!raw) return null;
  const u = new URL(raw);
  const noProxy = (env.NO_PROXY ?? env.no_proxy ?? "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  return { host: u.hostname, port: Number(u.port || 80), noProxy };
}

function bypassesProxy(proxy, host) {
  host = host.toLowerCase();
  return proxy.noProxy.some(rule => {
    rule = rule.replace(/^\*?\./, "");
    return host === rule || host.endsWith("." + rule);
  });
}

export function createRelay(options = {}) {
  const env = options.env || process.env;
  const token = options.token ?? env.DOCK_TOKEN ?? "open";
  const webRoot = options.webRoot ?? path.join(HERE, "..", "web");
  const allowPrivate = options.allowPrivate ?? env.DOCK_ALLOW_PRIVATE === "1";
  const proxy = options.proxy !== undefined ? options.proxy : parseProxy(env);
  const log = options.log ?? ((...a) => console.log(new Date().toISOString(), ...a));
  const names = new NameTable();
  const prefix = `/r/${token}`;

  async function resolveTarget(address) {
    const name = names.nameFor(address);
    if (name) return { host: name, viaName: true };
    if (/^198\.1[89]\./.test(address)) return null; // placeholder we never issued
    if (!allowPrivate && isPrivateV4(address)) return null;
    return { host: address, viaName: false };
  }

  /** Opens a TCP connection to host:port, directly or through the outbound proxy. */
  async function dial(host, port) {
    if (proxy && !bypassesProxy(proxy, host)) {
      return new Promise((resolve, reject) => {
        const sock = net.connect(proxy.port, proxy.host);
        let head = Buffer.alloc(0);
        const fail = err => { sock.destroy(); reject(err); };
        sock.once("error", fail);
        sock.once("connect", () => sock.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`));
        const onData = chunk => {
          head = Buffer.concat([head, chunk]);
          const end = head.indexOf("\r\n\r\n");
          if (end < 0) return;
          sock.off("data", onData);
          sock.off("error", fail);
          const status = Number(head.subarray(0, 12).toString().split(" ")[1]);
          if (status !== 200) return fail(new Error(`proxy refused ${host}:${port} (${status})`));
          const rest = head.subarray(end + 4);
          if (rest.length) sock.unshift(rest);
          sock.pause();
          resolve(sock);
        };
        sock.on("data", onData);
      });
    }
    let address = host;
    if (!net.isIP(host)) {
      const found = await dns.lookup(host, { family: 4 });
      address = found.address;
    }
    if (!allowPrivate && isPrivateAddress(address)) {
      throw new Error(`refusing private address for ${host}`);
    }
    return new Promise((resolve, reject) => {
      const sock = net.connect({ port, host: address });
      sock.once("error", reject);
      sock.once("connect", () => { sock.off("error", reject); sock.pause(); resolve(sock); });
    });
  }

  async function handleDns(req, res) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const query = Buffer.concat(chunks);
    const q = parseDnsQuestion(query);
    res.setHeader("content-type", "application/dns-message");
    res.setHeader("cache-control", "no-store");
    if (!q) { res.statusCode = 400; return res.end(); }
    if (q.type !== 1 || !q.name.includes(".")) {
      return res.end(dnsReply(query, q, {})); // no AAAA etc.: the VM is IPv4 only
    }
    if (!(proxy && !bypassesProxy(proxy, q.name))) {
      try {
        await dns.lookup(q.name, { family: 4 });
      } catch {
        return res.end(dnsReply(query, q, { rcode: 3 }));
      }
    }
    res.end(dnsReply(query, q, { address: names.ipFor(q.name) }));
  }

  function serveStatic(req, res, pathname, versioned) {
    let rel = decodeURIComponent(pathname);
    if (rel.endsWith("/")) rel += "index.html";
    const file = path.join(webRoot, path.normalize(rel));
    if (!file.startsWith(webRoot)) { res.statusCode = 403; return res.end(); }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) { res.statusCode = 404; return res.end("not found"); }
      const ext = path.extname(file);
      res.setHeader("content-type", MIME[ext] || "application/octet-stream");
      res.setHeader("content-length", st.size);
      // System-image files requested with ?v=<image version> never change.
      res.setHeader("cache-control", rel.startsWith("/vm/") && versioned
        ? "public, max-age=31536000, immutable" : "no-cache");
      if (req.method === "HEAD") return res.end();
      fs.createReadStream(file).pipe(res);
    });
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "content-type");
    if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }
    if (url.pathname === `${prefix}/info`) {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ dock: 1, flowControl: true, streamBuffer: STREAM_BUFFER }));
    }
    if (url.pathname === `${prefix}/dns-query` && req.method === "POST") {
      return handleDns(req, res).catch(err => { log("dns error", err.message); res.statusCode = 500; res.end(); });
    }
    if (url.pathname.startsWith("/r/")) { res.statusCode = 403; return res.end("bad relay token"); }
    if (req.method !== "GET" && req.method !== "HEAD") { res.statusCode = 405; return res.end(); }
    serveStatic(req, res, url.pathname, url.searchParams.has("v"));
  });

  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, "http://x");
    if (!url.pathname.startsWith(`${prefix}/wisp`)) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => handleWisp(ws));
  });

  function handleWisp(ws) {
    const streams = new Map(); // id -> {sock, pending: Buffer[], received, closed}

    const send = (type, id, payload) => {
      if (ws.readyState !== ws.OPEN) return;
      const frame = Buffer.allocUnsafe(5 + payload.length);
      frame.writeUInt8(type, 0);
      frame.writeUInt32LE(id, 1);
      payload.copy(frame, 5);
      ws.send(frame);
    };
    const sendContinue = id => { const b = Buffer.alloc(4); b.writeUInt32LE(STREAM_BUFFER, 0); send(WISP.CONTINUE, id, b); };
    const closeStream = (id, reason) => {
      const s = streams.get(id);
      if (!s) return;
      streams.delete(id);
      s.closed = true;
      if (s.sock) s.sock.destroy();
      send(WISP.CLOSE, id, Buffer.from([reason]));
    };

    sendContinue(0);

    ws.on("message", async data => {
      if (!Buffer.isBuffer(data)) data = Buffer.from(data);
      if (data.length < 5) return;
      const type = data.readUInt8(0);
      const id = data.readUInt32LE(1);
      const payload = data.subarray(5);

      if (type === WISP.CONNECT) {
        if (payload.length < 4 || streams.has(id)) return;
        const kind = payload.readUInt8(0);
        const port = payload.readUInt16LE(1);
        const address = payload.subarray(3).toString("latin1");
        const stream = { sock: null, pending: [], received: 0, closed: false, paused: false };
        streams.set(id, stream);
        if (kind !== 1) return closeStream(id, 0x41); // TCP only
        try {
          const target = await resolveTarget(address);
          if (!target) throw new Error(`blocked target ${address}`);
          const sock = await dial(target.host, port);
          if (stream.closed) { sock.destroy(); return; }
          stream.sock = sock;
          sock.setNoDelay(true);
          sock.on("data", chunk => {
            for (let off = 0; off < chunk.length; off += 16384) {
              send(WISP.DATA, id, chunk.subarray(off, off + 16384));
            }
            // Don't let the WebSocket queue grow without bound if the phone is slow.
            if (ws.bufferedAmount > 4 << 20) {
              sock.pause();
              const wait = setInterval(() => {
                if (stream.closed || ws.readyState !== ws.OPEN) return clearInterval(wait);
                if (ws.bufferedAmount < 1 << 20) { clearInterval(wait); if (!stream.paused) sock.resume(); }
              }, 20);
            }
          });
          sock.on("end", () => closeStream(id, 0x02));
          sock.on("error", () => closeStream(id, 0x03));
          sock.on("close", () => closeStream(id, 0x02));
          for (const chunk of stream.pending) sock.write(chunk);
          stream.pending = [];
          sock.resume();
        } catch (err) {
          log("connect failed", address, port, err.message);
          closeStream(id, 0x42);
        }
        return;
      }

      const stream = streams.get(id);
      if (!stream) return;
      if (type === WISP.DATA) {
        const chunk = Buffer.from(payload);
        let flushed = true;
        if (stream.sock) flushed = stream.sock.write(chunk); else stream.pending.push(chunk);
        if (++stream.received >= STREAM_BUFFER / 2) {
          stream.received = 0;
          if (flushed || !stream.sock) sendContinue(id);
          else stream.sock.once("drain", () => { if (!stream.closed) sendContinue(id); });
        }
      } else if (type === WISP.CLOSE) {
        streams.delete(id);
        stream.closed = true;
        if (stream.sock) stream.sock.end();
      } else if (type === WISP.PAUSE) {
        stream.paused = true;
        if (stream.sock) stream.sock.pause();
      } else if (type === WISP.RESUME) {
        stream.paused = false;
        if (stream.sock) stream.sock.resume();
      }
    });

    const teardown = () => {
      for (const s of streams.values()) { s.closed = true; if (s.sock) s.sock.destroy(); }
      streams.clear();
    };
    ws.on("close", teardown);
    ws.on("error", teardown);
  }

  return { server, token, prefix };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8080);
  const { server, prefix } = createRelay();
  server.listen(port, "0.0.0.0", () => {
    console.log(`Dock is running on http://localhost:${port}  (relay path ${prefix})`);
  });
}
