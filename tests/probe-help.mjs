import { execSync } from "node:child_process";
import { parseHelp } from "../web/js/recipes.js";
for (const cmd of ["curl --help all", "tar --help", "pip --help", "python3 -m http.server --help", "node --help", "zip --help", "gzip --help", "npm install --help"]) {
  let text = "";
  try { text = execSync(cmd + " 2>&1", { encoding: "utf8" }); } catch (e) { text = String(e.stdout || ""); }
  const { usage, options, commands } = parseHelp(text);
  console.log(`${cmd}: ${options.length} options, ${commands.length} commands, usage="${usage.slice(0, 50)}"`);
  for (const o of options.slice(0, 3)) console.log(`    ${o.short || "  "} ${o.flag}${o.arg ? " <" + o.arg + ">" : ""}  — ${o.description.slice(0, 70)}`);
}
