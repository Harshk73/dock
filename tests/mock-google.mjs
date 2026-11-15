// A local stand-in for the parts of Google's OAuth and Drive v3 APIs that Dock uses.
import http from "node:http";

export async function startMockGoogle() {
  const files = new Map(); // id -> {name, parents, mimeType, data: Buffer}
  const log = [];
  let nextId = 1;
  const TOKEN = "mock-access-token";

  const readBody = req => new Promise(resolve => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://mock");
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "authorization, content-type");
    res.setHeader("access-control-allow-methods", "GET, POST, PATCH, DELETE, OPTIONS");
    if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }
    const json = (code, body) => { res.statusCode = code; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body)); };

    if (url.pathname === "/o/oauth2/v2/auth") {
      const p = url.searchParams;
      if (p.get("response_type") !== "token" || !p.get("client_id") || !/drive\.file/.test(p.get("scope") || "")) return json(400, { error: "invalid_request" });
      res.statusCode = 302;
      res.setHeader("location", `${p.get("redirect_uri")}#state=${encodeURIComponent(p.get("state"))}&access_token=${TOKEN}&token_type=Bearer&expires_in=3599&scope=${encodeURIComponent(p.get("scope"))}`);
      return res.end();
    }
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(401, { error: { code: 401 } });
    log.push(`${req.method} ${url.pathname}`);

    if (url.pathname === "/drive/v3/about") {
      const usage = [...files.values()].reduce((n, f) => n + (f.data ? f.data.length : 0), 0);
      return json(200, { storageQuota: { limit: String(15 * 2 ** 30), usage: String(3 * 2 ** 30 + usage) }, user: { emailAddress: "you@example.com" } });
    }
    if (url.pathname === "/drive/v3/files" && req.method === "GET") {
      const q = url.searchParams.get("q") || "";
      const byName = q.match(/name='([^']+)'/);
      const byParent = q.match(/'([^']+)' in parents/);
      const hits = [...files.entries()].filter(([, f]) =>
        (!byName || f.name === byName[1]) && (!byParent || (f.parents || []).includes(byParent[1])) &&
        (!/mimeType='application\/vnd.google-apps.folder'/.test(q) || f.mimeType === "application/vnd.google-apps.folder"));
      return json(200, { files: hits.map(([id, f]) => ({ id, name: f.name })) });
    }
    if (url.pathname === "/drive/v3/files" && req.method === "POST") {
      const meta = JSON.parse((await readBody(req)).toString());
      const id = `f${nextId++}`;
      files.set(id, { ...meta, data: null });
      return json(200, { id });
    }
    if (url.pathname === "/upload/drive/v3/files" && req.method === "POST") {
      const body = await readBody(req);
      const boundary = req.headers["content-type"].match(/boundary=(.+)$/)[1];
      const first = body.indexOf("\r\n\r\n") + 4;
      const metaEnd = body.indexOf(`\r\n--${boundary}`, first);
      const meta = JSON.parse(body.subarray(first, metaEnd).toString());
      const mediaStart = body.indexOf("\r\n\r\n", metaEnd + 4) + 4;
      const mediaEnd = body.lastIndexOf(`\r\n--${boundary}--`);
      const id = `f${nextId++}`;
      files.set(id, { ...meta, data: Buffer.from(body.subarray(mediaStart, mediaEnd)) });
      return json(200, { id });
    }
    const upload = url.pathname.match(/^\/upload\/drive\/v3\/files\/(\w+)$/);
    if (upload && req.method === "PATCH") {
      if (!files.has(upload[1])) return json(404, {});
      files.get(upload[1]).data = await readBody(req);
      return json(200, { id: upload[1] });
    }
    const file = url.pathname.match(/^\/drive\/v3\/files\/(\w+)$/);
    if (file && req.method === "GET") {
      const f = files.get(file[1]);
      if (!f) return json(404, {});
      res.statusCode = 200;
      return res.end(f.data);
    }
    if (file && req.method === "DELETE") {
      files.delete(file[1]);
      res.statusCode = 204;
      return res.end();
    }
    json(404, { error: "unknown endpoint" });
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base, files, log,
    endpoints: { api: base, auth: `${base}/o/oauth2/v2/auth` },
    manifest() {
      const entry = [...files.values()].find(f => f.name === "manifest.json");
      return entry ? JSON.parse(entry.data.toString()) : null;
    },
    chunkFiles: () => [...files.values()].filter(f => /^c\d+-g\d+\.gz$/.test(f.name)),
    close: () => server.close(),
  };
}
