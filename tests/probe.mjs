// Scratch runner: boots a VM whose disk persists in a directory and runs commands.
// Usage: node tests/probe.mjs <overlay-dir> "cmd" ...
import { startVm, DirOverlay } from "./node-vm.mjs";
import { trustSandboxCa } from "./sandbox-ca.mjs";
const [dir, ...cmds] = process.argv.slice(2);
const vm = await startVm({ overlay: new DirOverlay(dir) });
await trustSandboxCa(vm);
for (const cmd of cmds) {
  const r = await vm.sh(cmd);
  console.log(`--- $ ${cmd.slice(0, 200)}\n[exit ${r.code}, ${(r.ms / 1000).toFixed(1)}s]\n${r.text.slice(-(Number(process.env.TAIL) || 3000))}`);
}
await vm.stop();
process.exit(0);
