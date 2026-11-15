// Renders web/icons/icon.svg to the PNG sizes iOS and the web manifest want.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "web", "icons");
const svg = fs.readFileSync(path.join(dir, "icon.svg"), "utf8");
const browser = await chromium.launch();
for (const size of [180, 192, 512]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<style>html,body{margin:0}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
  await page.screenshot({ path: path.join(dir, `icon-${size}.png`) });
  await page.close();
}
await browser.close();
console.log("icons written");
