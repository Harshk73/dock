import { startVm } from "./node-vm.mjs";
const timeout = setTimeout(() => { console.error("TIMEOUT"); process.exit(2); }, 240000);
const vm = await startVm({ echo: true });
console.log(`\n--- booted in ${vm.bootMs} ms`);
for (const cmd of ["uname -a; cat /etc/alpine-release; free -m | head -2; df -h / | tail -1; ip addr show eth0 | grep inet", "python3 --version; node --version; git --version"]) {
  const r = await vm.sh(cmd);
  console.log(`--- [${r.code}] ${r.ms} ms\n${r.text}`);
}
console.log("disk stats", vm.disk.stats, "dirty", vm.disk.dirtyCount);
await vm.stop();
clearTimeout(timeout);
process.exit(0);
