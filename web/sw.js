// Dock service worker: offline shell, cached VM files, and the bridge that lets a web
// app running inside the VM be shown in an iframe (see js/preview.js).

const SHELL = "dock-shell-v1";
const VM = "dock-vm-v1";
const SCOPE = new URL(self.registration.scope).pathname;
const previewClients = new Map(); // clientId -> port | null

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));

function previewPort(pathname) {
  const m = pathname.slice(SCOPE.length).match(/^preview\/(\d{1,5})(\/.*)?$/);
  return m ? { port: Number(m[1]), path: m[2] || "/" } : null;
}

async function portForRequest(event, url) {
  const direct = previewPort(url.pathname);
  if (direct) return { port: direct.port, path: direct.path + url.search };
  // A page inside a preview asked for an absolute path such as /static/app.js.
  let port = null;
  if (event.request.referrer) {
    const ref = previewPort(new URL(event.request.referrer).pathname);
    if (ref) port = ref.port;
  }
  if (!port && event.clientId) {
    if (!previewClients.has(event.clientId)) {
      const client = await self.clients.get(event.clientId);
      const hit = client ? previewPort(new URL(client.url).pathname) : null;
      previewClients.set(event.clientId, hit ? hit.port : null);
      if (previewClients.size > 200) previewClients.delete(previewClients.keys().next().value);
    }
    port = previewClients.get(event.clientId);
  }
  return port ? { port, path: url.pathname + url.search } : null;
}

async function appClient() {
  const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  return all.find(c => !previewPort(new URL(c.url).pathname) && new URL(c.url).pathname.startsWith(SCOPE)) || null;
}

const DROP_RESPONSE = new Set(["content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive",
  "x-frame-options", "content-security-policy", "referrer-policy", "set-cookie", "strict-transport-security"]);

async function proxy(event, target) {
  const client = await appClient();
  if (!client) return new Response("Open Dock to use this preview.", { status: 503 });
  const request = event.request;
  const body = request.method === "GET" || request.method === "HEAD" ? null : await request.arrayBuffer();
  const reply = await new Promise(resolve => {
    const channel = new MessageChannel();
    channel.port1.onmessage = e => resolve(e.data);
    client.postMessage({ type: "dock-http", port: target.port, method: request.method, path: target.path, headers: [...request.headers], body }, [channel.port2]);
    setTimeout(() => resolve({ error: "The app took too long to answer." }), 125000);
  });
  if (reply.error) {
    return new Response(`<!doctype html><meta name="viewport" content="width=device-width"><body style="font:16px system-ui;padding:32px;background:#0a0b10;color:#f3f4f8"><h3>Can't reach the app</h3><p style="color:#9498a8">${reply.error}</p>`,
      { status: 502, headers: { "content-type": "text/html; charset=utf-8" } });
  }
  const headers = new Headers();
  for (const [name, value] of reply.headers) {
    const lower = name.toLowerCase();
    if (DROP_RESPONSE.has(lower)) continue;
    if (lower === "location") {
      // Keep redirects inside the preview.
      const to = value.replace(/^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?/i, "");
      headers.append(name, to.startsWith("/") ? `${SCOPE}preview/${target.port}${to}` : to);
      continue;
    }
    try { headers.append(name, value); } catch { /* not a valid header */ }
  }
  const empty = reply.status === 204 || reply.status === 304 || reply.status < 200 || request.method === "HEAD";
  return new Response(empty ? null : reply.body, { status: reply.status < 200 ? 502 : reply.status, headers });
}

async function cacheFirst(request) {
  const cache = await caches.open(VM);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok) cache.put(request, res.clone()).catch(() => {});
  return res;
}

async function networkFirst(request) {
  const cache = await caches.open(SHELL);
  try {
    const res = await fetch(request);
    if (res.ok) cache.put(request, res.clone()).catch(() => {});
    return res;
  } catch (err) {
    const hit = await cache.match(request, { ignoreSearch: request.mode === "navigate" });
    if (hit) return hit;
    throw err;
  }
}

self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (url.origin !== location.origin || !url.pathname.startsWith(SCOPE)) return;
  const rel = url.pathname.slice(SCOPE.length);
  if (rel.startsWith("r/")) return; // network relay
  event.respondWith((async () => {
    const target = await portForRequest(event, url);
    if (target) return proxy(event, target);
    if (event.request.method !== "GET") return fetch(event.request);
    // Versioned system-image files never change; everything else is revalidated.
    if (rel.startsWith("vm/") && url.searchParams.has("v")) return cacheFirst(event.request);
    return networkFirst(event.request);
  })());
});
