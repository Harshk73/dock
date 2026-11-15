// Prints the plan Dock derives for real repositories. Usage: node tests/plan-repos.mjs [owner/repo ...]
import { parseRepoUrl, fetchRepoFacts } from "../web/js/github.js";
import { buildPlan } from "../web/js/planner.js";
const repos = process.argv.slice(2);
for (const input of repos) {
  const target = parseRepoUrl(input);
  try {
    const facts = await fetchRepoFacts(target);
    const plan = buildPlan(facts);
    console.log(`\n=== ${input}  [${plan.runtime}/${plan.kind}] ${plan.method}  name=${plan.name} launch=${JSON.stringify(plan.launchLabel || plan.launch)} port=${plan.port} badges=${plan.badges}`);
    console.log(`    files: ${Object.keys(facts.files).join(", ")}  npm=${JSON.stringify(facts.npm)} pypi=${facts.pypi ? facts.pypi.name + " match=" + facts.pypi.matchesRepo : null}`);
    console.log(`    desc: ${plan.description}`);
    plan.steps.forEach((s, i) => console.log(`    ${i + 1}. ${s.title}\n         ${s.cmd.split("\n")[0].slice(0, 150)}`));
    if (plan.fallback) console.log(`    fallback: ${plan.fallback.method} (${plan.fallback.steps.length} steps)`);
    plan.warnings.forEach(w => console.log(`    ! [${w.level}] ${w.text}`));
  } catch (err) {
    console.log(`\n=== ${input}  ERROR ${err.message}`);
  }
}
