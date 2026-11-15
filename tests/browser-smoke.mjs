// Loads Dock in a phone-sized browser and takes screenshots of the first screens.
import fs from "node:fs";
import { chromium, devices } from "playwright";
import { serve } from "./serve.mjs";

const shots = process.env.SHOTS || "/tmp/claude-0/-home-user/695b14cd-41e5-5f7d-9343-86edcfeb245d/scratchpad/shots";
fs.mkdirSync(shots, { recursive: true });
const server = await serve();
const browser = await chromium.launch({ proxy: process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: "127.0.0.1,localhost" } : undefined });
const iphone = devices["iPhone 14"];
const context = await browser.newContext({ ...iphone, deviceScaleFactor: 1, permissions: ["clipboard-read", "clipboard-write"] });
const page = await context.newPage();
const errors = [];
page.on("pageerror", e => errors.push("pageerror: " + e.message));
page.on("console", m => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push("console: " + m.text()); });
await page.goto(server.url);
await page.waitForTimeout(1500);
await page.screenshot({ path: `${shots}/01-home-booting.png` });
const t0 = Date.now();
await page.waitForSelector('#vm-pill[data-state="ready"]', { timeout: 240000 });
console.log("Linux ready in browser after", Date.now() - t0, "ms");
await page.screenshot({ path: `${shots}/02-home-ready.png` });
console.log("errors:", errors);
await browser.close();
server.close();
process.exit(0);
