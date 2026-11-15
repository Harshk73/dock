import { startVm } from "./node-vm.mjs";
import { trustSandboxCa } from "./sandbox-ca.mjs";
const timeout = setTimeout(() => { console.error("TIMEOUT"); process.exit(2); }, 900000);
const vm = await startVm();
console.log(`booted in ${vm.bootMs} ms; sandbox CA: ${await trustSandboxCa(vm)}`);
const steps = process.argv.slice(2).length ? process.argv.slice(2) : [
  "nslookup pypi.org 2>&1 | tail -3",
  "curl -sS -o /dev/null -w 'pypi %{http_code} %{time_total}s\\n' https://pypi.org/simple/pip/",
  "apk update 2>&1 | tail -3",
  "cd /tmp && python3 -m venv v && ./v/bin/pip install cowsay 2>&1 | tail -2 && ./v/bin/cowsay -t hi | head -3",
  "cd /tmp && git clone --depth 1 https://github.com/octocat/Hello-World.git 2>&1 | tail -2 && ls Hello-World",
  "npm install -g cowsay 2>&1 | tail -3; cowsay hi | head -3",
];
for (const cmd of steps) {
  const r = await vm.sh(cmd);
  console.log(`--- $ ${cmd}\n[exit ${r.code}, ${(r.ms / 1000).toFixed(1)}s]\n${r.text}`);
}
await vm.stop();
clearTimeout(timeout);
process.exit(0);
