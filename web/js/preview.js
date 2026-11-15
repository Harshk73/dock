// Shows web apps that run inside the VM. The service worker (sw.js) intercepts
// requests under /preview/<port>/ and asks this page to perform them over a TCP
// connection the guest agent opens to that port. Plain HTTP only: WebSockets and
// cookies set by the app are not carried.

const SKIP_REQUEST = new Set(["host", "connection", "accept-encoding", "content-length", "origin", "referer", "upgrade-insecure-requests"]);

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

function indexOf(bytes, pattern, from = 0) {
  outer: for (let i = from; i <= bytes.length - pattern.length; i++) {
    for (let j = 0; j < pattern.length; j++) if (bytes[i + j] !== pattern[j]) continue outer;
    return i;
  }
  return -1;
}

function decodeChunked(bytes) {
  const parts = [];
  const decoder = new TextDecoder();
  let pos = 0;
  while (pos < bytes.length) {
    const eol = indexOf(bytes, [13, 10], pos);
    if (eol < 0) break;
    const size = parseInt(decoder.decode(bytes.subarray(pos, eol)).split(";")[0].trim(), 16);
    if (!size) break;
    parts.push(bytes.subarray(eol + 2, eol + 2 + size));
    pos = eol + 2 + size + 2;
  }
  return concat(parts);
}

/** Performs one HTTP request against a port inside the VM. */
export async function httpViaAgent(agent, { port, method, path, headers, body }) {
  const lines = [`${method} ${path} HTTP/1.1`, `Host: localhost:${port}`, "Connection: close", "Accept-Encoding: identity"];
  for (const [name, value] of headers || []) {
    if (!SKIP_REQUEST.has(name.toLowerCase()) && !name.toLowerCase().startsWith("sec-")) lines.push(`${name}: ${value}`);
  }
  const payload = body ? new Uint8Array(body) : null;
  if (payload) lines.push(`Content-Length: ${payload.length}`);
  const conn = agent.connect(port);
  const received = [];
  conn.onData = bytes => received.push(bytes);
  conn.write(lines.join("\r\n") + "\r\n\r\n");
  if (payload) conn.write(payload);
  const timer = setTimeout(() => conn.close(), 120000);
  const code = await conn.exited;
  clearTimeout(timer);
  const all = concat(received);
  const split = indexOf(all, [13, 10, 13, 10]);
  if (split < 0) {
    return { error: code === 1 && !all.length ? `Nothing is listening on port ${port} yet.` : "The app closed the connection without answering." };
  }
  const head = new TextDecoder().decode(all.subarray(0, split)).split("\r\n");
  const status = Number(head[0].split(" ")[1]) || 502;
  const outHeaders = [];
  let chunked = false;
  for (const line of head.slice(1)) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (name.toLowerCase() === "transfer-encoding" && /chunked/i.test(value)) chunked = true;
    outHeaders.push([name, value]);
  }
  let data = all.subarray(split + 4);
  if (chunked) data = decodeChunked(data);
  const buffer = data.slice().buffer;
  return { status, headers: outHeaders, body: buffer };
}

/** True once something inside the VM answers on the port. */
export async function probePort(agent, port) {
  const conn = agent.connect(port);
  let answered = false;
  conn.onData = () => { answered = true; conn.close(); };
  conn.write("HEAD / HTTP/1.0\r\n\r\n");
  const timer = setTimeout(() => conn.close(), 8000);
  const code = await conn.exited;
  clearTimeout(timer);
  return answered || code === 0;
}

export function installPreviewBridge(getAgent) {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.addEventListener("message", async event => {
    if (!event.data || event.data.type !== "dock-http") return;
    const reply = event.ports[0];
    const agent = getAgent();
    if (!agent) return reply.postMessage({ error: "Linux is not running." });
    try {
      const result = await httpViaAgent(agent, event.data);
      reply.postMessage(result, result.body ? [result.body] : []);
    } catch (err) {
      reply.postMessage({ error: String(err && err.message || err) });
    }
  });
}
