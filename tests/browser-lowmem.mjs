// Start-up on devices that can't give WebAssembly much memory (like iPhones).
// V8's --wasm-max-mem-pages caps memory the way a phone's limits do.
// Usage: node tests/browser-lowmem.mjs <max 64 KiB pages> <expect: ready|error> [seconds]
import { chromium, devices } from "playwright";
import { serve } from "./serve.mjs";
import { SHOTS } from "./browser-lib.mjs";

const [pages = "5000", expect = "ready", limit = "240"] = process.argv.slice(2);
const server = await serve();
const browser = await chromium.launch({ args: [`--js-flags=--wasm-max-mem-pages=${pages}`] });
const page = await (await browser.newContext({ ...devices["iPhone 14"], deviceScaleFactor: 1 })).newPage();
let reloads = -1;
page.on("load", () => reloads++);
await page.goto(server.url);
const seen = new Set();
const t0 = Date.now();
let s;
while (Date.now() - t0 < Number(limit) * 1000) {
  await page.waitForTimeout(2000);
  s = await page.evaluate(() => window.dock && ({ status: window.dock.state.vm.status, mem: window.dock.state.settings.memoryMB, pill: document.getElementById("vm-pill-text").textContent, term: document.getElementById("term-empty-text").textContent })).catch(() => null);
  if (!s) continue;
  const key = `${s.mem} MB · ${s.pill}`;
  if (!seen.has(key)) { seen.add(key); console.log(`${Math.round((Date.now() - t0) / 1000)}s  ${key}  |  ${s.term}`); }
  if (s.status === "ready" || s.status === "error") break;
}
console.log(`result: ${s && s.status} at ${s && s.mem} MB after ${reloads} automatic reload(s), ${Math.round((Date.now() - t0) / 1000)}s`);
if (s && s.status === "error") {
  console.log("message:", s.term);
  await page.click('.tab[data-view="dock"]');
  await page.click("#vm-pill");
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SHOTS}/40-boot-error.png` });
  console.log("--- diagnostics ---\n" + (await page.evaluate(() => window.dock.diagnostics())).split("--- boot log ---")[0]);
}
await browser.close(); server.close();
process.exit(s && s.status === expect ? 0 : 1);
