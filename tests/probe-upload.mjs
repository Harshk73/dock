import crypto from "node:crypto";
import { startVm } from "./node-vm.mjs";
const vm = await startVm();
const agent = vm.machine.agent;
const data = new Uint8Array(crypto.randomBytes(3_000_000));
for (const [block, frame] of [[32768, 4096], [262144, 4096], [262144, 32768], [1048576, 60000]]) {
  const s = agent.open({ script: "cat > /tmp/x.bin", pty: false, stdin: true });
  const t = Date.now();
  for (let off = 0; off < data.length; off += block) {
    const part = data.subarray(off, off + block);
    for (let o = 0; o < part.length; o += frame) agent.frame(2, s.channel, part.subarray(o, o + frame));
    await agent.ping(120000);
  }
  s.end();
  await s.exited;
  const r = await vm.sh("md5sum < /tmp/x.bin");
  console.log(`block ${block} frame ${frame}: ${(3 / ((Date.now() - t) / 1000)).toFixed(2)} MB/s ok=${r.text.startsWith(crypto.createHash("md5").update(data).digest("hex"))}`);
}
await vm.stop();
process.exit(0);
