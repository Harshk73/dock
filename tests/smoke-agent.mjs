import assert from "node:assert/strict";
import { startVm } from "./node-vm.mjs";
const timeout = setTimeout(() => { console.error("TIMEOUT"); process.exit(2); }, 300000);
const vm = await startVm();
const agent = vm.machine.agent;
console.log(`booted in ${vm.bootMs} ms`, agent.info);

// plain capture
let r = await vm.sh("echo hello; echo err >&2; exit 3");
assert.equal(r.code, 3); assert.match(r.text, /hello\nerr/);
console.log("capture ok", r.ms, "ms");

// environment from the login profile
r = await vm.sh("echo $PATH; echo $HOME; pwd");
assert.match(r.text, /\/dock\/bin/); assert.match(r.text, /\/root\n\/root/);

// two jobs at once
const t0 = Date.now();
const [a, b] = await Promise.all([vm.sh("sleep 3; echo A"), vm.sh("sleep 3; echo B")]);
assert.equal(a.text.trim(), "A"); assert.equal(b.text.trim(), "B");
assert.ok(Date.now() - t0 < 5500, "jobs ran concurrently");
console.log("concurrent ok", Date.now() - t0, "ms");

// interactive terminal session with resize
const shell = agent.open({ rows: 30, cols: 100 });
let seen = "";
shell.onData = bytes => { seen += Buffer.from(bytes).toString(); };
const waitFor = async (re, ms = 20000) => {
  const end = Date.now() + ms;
  while (!re.test(seen)) { if (Date.now() > end) throw new Error("timeout waiting for " + re + "\n" + seen); await new Promise(r => setTimeout(r, 50)); }
};
await waitFor(/dock.*[#$] /);
shell.write("stty size\n");
await waitFor(/30 100/);
shell.resize(40, 120);
shell.write("stty size\n");
await waitFor(/40 120/);
shell.write("tty; echo done-$((6*7))\n");
await waitFor(/done-42/);
console.log("terminal ok");

// large output and large input survive intact
r = await vm.sh("head -c 300000 /dev/urandom | base64 -w0 | tee /tmp/blob | wc -c; md5sum < /tmp/blob");
const [len, sum] = r.text.trim().split(/\s+/);
r = await vm.sh("cat /tmp/blob");
assert.equal(r.text.length, Number(len));
const crypto = await import("node:crypto");
assert.equal(crypto.createHash("md5").update(r.text).digest("hex"), sum);
const big = "x".repeat(50000);
r = await vm.sh(`cat > /tmp/in <<'EOT'\n${big}\nEOT\nwc -c < /tmp/in`);
assert.equal(r.text.trim(), "50001");
console.log("bulk transfer ok", r.ms, "ms");

// closing a session kills it
const sleeper = agent.open({ script: "sleep 600" });
await new Promise(r => setTimeout(r, 1500));
sleeper.close();
const code = await sleeper.exited;
assert.ok(code > 128, "killed by signal: " + code);
shell.write("exit\n");
assert.equal(await shell.exited, 0);

// TCP connection into the guest (what app previews use)
const web = agent.open({ script: "cd /tmp && echo preview-works > hello.txt && python3 -m http.server 8123 --bind 127.0.0.1" });
let http = "";
for (let i = 0; i < 60 && !/200 OK/.test(http); i++) {
  await new Promise(r => setTimeout(r, 1000));
  const conn = agent.connect(8123);
  http = "";
  conn.onData = bytes => { http += Buffer.from(bytes).toString(); };
  conn.write("GET /hello.txt HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
  await conn.exited;
}
assert.match(http, /200 OK[\s\S]*preview-works/);
const refused = agent.connect(9);
assert.equal(await refused.exited, 1);
web.close();
console.log("tcp preview ok");

await agent.sync();
console.log("sync ok; dirty chunks", vm.disk.dirtyCount);
await vm.stop();
clearTimeout(timeout);
console.log("ALL OK");
process.exit(0);
