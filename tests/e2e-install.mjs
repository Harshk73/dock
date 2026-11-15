// End-to-end without a browser: repo link -> plan -> install inside the VM -> run it.
// Usage: NODE_USE_ENV_PROXY=1 node tests/e2e-install.mjs owner/repo "command to verify" ...
import { startVm } from "./node-vm.mjs";
import { trustSandboxCa } from "./sandbox-ca.mjs";
import { parseRepoUrl, fetchRepoFacts } from "../web/js/github.js";
import { buildPlan } from "../web/js/planner.js";
import { runInstall, runUninstall } from "../web/js/installer.js";

const args = process.argv.slice(2);
const timeout = setTimeout(() => { console.error("TIMEOUT"); process.exit(2); }, 1500000);
const vm = await startVm();
await trustSandboxCa(vm);
console.log(`booted in ${vm.bootMs} ms`);
let failed = 0;
for (let i = 0; i < args.length; i += 2) {
  const plan = buildPlan(await fetchRepoFacts(parseRepoUrl(args[i])));
  console.log(`\n=== ${args[i]}: ${plan.method}`);
  const t = Date.now();
  let log = "";
  try {
    const result = await runInstall({
      agent: vm.machine.agent, plan, control: { cancelled: false }, size: { rows: 24, cols: 100 },
      onEvent: e => {
        if (e.type === "step") console.log(`   step ${e.index + 1} ${e.state} (+${((Date.now() - t) / 1000).toFixed(0)}s)`);
        if (e.type === "steps") console.log(`   ${e.method}: ${e.steps.length} steps`);
        if (e.type === "output") log += Buffer.from(e.bytes).toString();
      },
    });
    console.log(`   installed in ${((Date.now() - t) / 1000).toFixed(0)}s; commands: ${result.bins.join(", ") || "(none)"}`);
    const check = await vm.sh(args[i + 1]);
    console.log(`   $ ${args[i + 1]}  -> exit ${check.code} in ${(check.ms / 1000).toFixed(1)}s\n${check.text.trim().split("\n").slice(0, 8).map(l => "     " + l).join("\n")}`);
    if (check.code !== 0) failed++;
    if (process.env.UNINSTALL) {
      const app = { id: plan.id, uninstall: plan.uninstall };
      const un = await runUninstall(vm.machine.agent, app);
      const left = await vm.sh(`ls /dock/apps; ls /dock/bin`);
      console.log(`   uninstall exit ${un.code}; left: ${left.text.trim().replace(/\n/g, " ") || "(nothing)"}`);
    }
  } catch (err) {
    failed++;
    console.log(`   FAILED: ${err.message}\n${log.split("\n").slice(-15).join("\n")}`);
  }
}
await vm.machine.save();
console.log(`\ndisk: ${vm.overlay.map.size} MiB written`);
await vm.stop();
clearTimeout(timeout);
process.exit(failed ? 1 : 0);
