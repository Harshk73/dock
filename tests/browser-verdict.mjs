// The install sheet's phone-compatibility verdict, for a few real repositories.
import assert from "node:assert/strict";
import { launch } from "./browser-lib.mjs";
const t = await launch({ scale: Number(process.env.SCALE || 1) });
const { page, shot } = t;
await page.goto(t.server.url);
const cases = [["BurntSushi/ripgrep", "good", "Install"], ["anthropics/skills", "maybe", "Try installing"], ["openfilm/openfilm", "no", "OK"]];
for (const [repo, level, button] of cases) {
  await page.fill("#add-input", repo);
  await page.click(".addbar-go");
  await page.waitForSelector(".verdict", { timeout: 90000 });
  await page.waitForTimeout(500);
  const cls = await page.getAttribute(".verdict", "class");
  const head = await page.textContent(".verdict-head strong");
  const primary = (await page.textContent(".sheet .sheet-foot .btn.primary")).trim();
  console.log(`${repo}: ${head} [${cls}] button "${primary}"`);
  assert.ok(cls.includes(`v-${level}`), cls);
  assert.equal(primary, button);
  await shot(`50-verdict-${level}`);
  await page.click(".sheet .sheet-foot .btn:not(.primary)").catch(() => page.click(".sheet .sheet-foot .btn.primary"));
  await page.waitForTimeout(500);
}
console.log("errors:", t.errors);
await t.close();
process.exit(0);
