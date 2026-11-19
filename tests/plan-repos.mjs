// Prints Dock's install plan and phone-compatibility verdict for real repositories.
// Usage: NODE_USE_ENV_PROXY=1 node tests/plan-repos.mjs [--brief] owner/repo ...
import { parseRepoUrl, fetchRepoFacts } from "../web/js/github.js";
import { buildPlan } from "../web/js/planner.js";
import { assessCompatibility } from "../web/js/compat.js";
import { createRelay } from "../server/relay.mjs";

const args = process.argv.slice(2);
const brief = args[0] === "--brief" && args.shift();
const relay = createRelay({ log: () => {} });
await new Promise(r => relay.server.listen(0, "127.0.0.1", r));
const relayBase = `http://127.0.0.1:${relay.server.address().port}${relay.prefix}`;
for (const input of args) {
  try {
    const facts = await fetchRepoFacts(parseRepoUrl(input), { relayBase });
    const plan = buildPlan(facts);
    const v = assessCompatibility(facts, plan, { hasAiKey: false });
    const mark = { good: "✅", maybe: "🟡", no: "⛔" }[v.level];
    console.log(`${mark} ${input.padEnd(42)} ${plan.method || "-"}${plan.alpine ? ` (${plan.alpine.name})` : ""}`);
    for (const r of v.reasons.filter(r => !brief || r.level !== "info")) console.log(`     ${r.level.padEnd(5)} ${r.text}${r.quote ? `\n           “${r.quote}”` : ""}`);
    if (!brief) plan.steps.forEach((s, i) => console.log(`     ${i + 1}. ${s.title}`));
  } catch (err) {
    console.log(`?? ${input}  ERROR ${err.message}`);
  }
}
relay.server.close();
process.exit(0);
