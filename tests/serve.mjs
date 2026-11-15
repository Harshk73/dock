// Starts Dock for browser tests. In the build sandbox the relay must route through
// the sandbox's HTTPS proxy.
import { createRelay } from "../server/relay.mjs";
export async function serve(port = 0) {
  const upstream = process.env.HTTPS_PROXY ? new URL(process.env.HTTPS_PROXY) : null;
  const relay = createRelay({
    log: () => {},
    proxy: upstream ? { host: upstream.hostname, port: Number(upstream.port), noProxy: [] } : null,
  });
  await new Promise(r => relay.server.listen(port, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${relay.server.address().port}/`, close: () => { relay.server.closeAllConnections(); relay.server.close(); } };
}
if (process.argv[1].endsWith("serve.mjs")) {
  const s = await serve(Number(process.env.PORT || 8090));
  console.log("serving", s.url);
}
