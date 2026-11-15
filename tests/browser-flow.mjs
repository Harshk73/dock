// Full flow in a phone-sized browser: link -> plan -> install -> run -> settings.
import assert from "node:assert/strict";
import { launch } from "./browser-lib.mjs";

const repo = process.argv[2] || "piuccio/cowsay";
const command = process.argv[3] || "cowsay Hello from my phone";
const expect = new RegExp(process.argv[4] || "Hello from my phone");
const t = await launch({ scale: Number(process.env.SCALE || 1) });
const { page, shot } = t;
await page.goto(t.server.url);
await t.ready();
await t.trustSandboxCa();

await page.fill("#add-input", `https://github.com/${repo}`);
await page.click(".addbar-go");
await page.waitForSelector("#install-go", { timeout: 60000 });
await page.waitForTimeout(500);
await shot("03-plan");
await page.click(".sheet .link");
await page.waitForTimeout(300);
await shot("04-plan-commands");
await page.click("#install-go");
await page.waitForSelector('.step[data-state="running"]', { timeout: 60000 });
await page.waitForTimeout(6000);
await shot("05-installing");
const t0 = Date.now();
await page.waitForFunction(() => /is ready|Install failed/.test(document.querySelector(".sheet.full h2")?.textContent || ""), null, { timeout: 900000 });
console.log("install finished after", Math.round((Date.now() - t0) / 1000), "s:", await page.textContent(".sheet.full h2"));
await page.waitForTimeout(500);
await shot("06-installed");
assert.match(await page.textContent(".sheet.full h2"), /is ready/);

await page.click(".sheet.full .btn.primary"); // Open in Terminal
await page.waitForSelector(".term-pane.active .xterm", { timeout: 20000 });
await page.waitForFunction(() => /[#$] \S+ $/.test(window.dock.terminals.active()?.term.buffer.active.getLine(window.dock.terminals.active().term.buffer.active.cursorY)?.translateToString(true) + " "), null, { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(1500);
await shot("07-terminal-pretyped");
// Finish the command the app pre-typed.
await page.evaluate(cmd => {
  const tab = window.dock.terminals.active();
  tab.session.write("\x15" + cmd + "\n");
}, command);
await page.waitForFunction(re => {
  const term = window.dock.terminals.active().term;
  let text = "";
  for (let i = 0; i < term.buffer.active.length; i++) text += term.buffer.active.getLine(i).translateToString(true) + "\n";
  return new RegExp(re).test(text.replace(/\n/g, " "));
}, expect.source, { timeout: 120000 });
await page.waitForTimeout(800);
await shot("08-terminal-output");

await page.click('.tab[data-view="dock"]');
await page.waitForTimeout(600);
await shot("09-dock-with-app");
await page.click(".tile");
await page.waitForTimeout(700);
await shot("10-app-sheet");
await page.click(".sheet .btn:not(.primary):not(.danger)").catch(() => {});
await page.mouse.click(195, 40);
await page.waitForTimeout(500);
await page.click('.tab[data-view="settings"]');
await page.waitForTimeout(800);
await shot("11-settings");
console.log("errors:", t.errors);
await t.close();
process.exit(0);
