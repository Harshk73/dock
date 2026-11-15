// The per-app workspace in a phone-sized browser: recipe screens (yt-dlp, ffmpeg),
// the automatic --help screen (ripgrep), Files, and Ask AI against a mock API.
// The downloaded clip is a generated test pattern served by a local web server.
import assert from "node:assert/strict";
import fs from "node:fs";
import { launch } from "./browser-lib.mjs";
import { startMockAnthropic } from "./mock-anthropic.mjs";

import http from "node:http";
import os from "node:os";
const clip = fs.readFileSync(new URL("./fixtures/test-clip.mp4", import.meta.url));
const hostIp = Object.values(os.networkInterfaces()).flat().find(i => i.family === "IPv4" && !i.internal).address;
const media = http.createServer((req, res) => {
  res.setHeader("content-type", "video/mp4");
  res.setHeader("content-length", clip.length);
  res.setHeader("accept-ranges", "none");
  res.end(req.method === "HEAD" ? undefined : clip);
});
await new Promise(r => media.listen(0, "0.0.0.0", r));
const SAMPLE = `http://${hostIp}:${media.address().port}/test-clip.mp4`;
const ai = await startMockAnthropic({ commands: ["ls /root/Files", "rg -ci hello /root/Files/notes.txt"], finalText: "Your notes mention hello on 2 lines." });
const t = await launch({ scale: Number(process.env.SCALE || 1), direct: [hostIp] });
const { page, shot } = t;
await t.context.addInitScript(base => { try { localStorage.setItem("dock.dev.anthropic", JSON.stringify({ baseURL: base })); } catch { /* embedded third-party frame */ } }, ai.baseURL);
const sh = script => page.evaluate(s => window.dock.state.vm.machine.agent.capture(s), script);
const step = name => console.log(`ok - ${name}`);

async function install(repo) {
  await page.fill("#add-input", repo);
  await page.click(".addbar-go");
  await page.waitForSelector("#install-go", { timeout: 60000 });
  await page.click("#install-go");
  await page.waitForFunction(() => /is ready|Install failed/.test(document.querySelector(".sheet.full h2")?.textContent || ""), null, { timeout: 900000 });
  assert.match(await page.textContent(".sheet.full h2"), /is ready/);
}

await page.goto(t.server.url);
await t.ready();
await t.trustSandboxCa();

// ---------------------------------------------------------------- yt-dlp: site companion
await install("yt-dlp/yt-dlp");
assert.match(await page.textContent(".sheet.full"), /Works with YouTube/);
await shot("20-installed-with-sites");
assert.equal((await page.textContent(".sheet.full .btn.primary")).trim(), "Open YouTube");
await page.click(".sheet.full .btn.primary");
await page.waitForSelector(".workspace .ws-search input");
await page.fill(".ws-search input", "big buck bunny blender");
await page.keyboard.press("Enter");
await page.waitForSelector(".result", { timeout: 180000 });
const titles = await page.locator(".result strong").allTextContents();
console.log("   search results:", titles.length, "first:", titles[0]);
assert.ok(titles.length >= 3);
await page.waitForTimeout(400);
await shot("21-youtube-results");
await page.click(".result");
await page.waitForSelector(".action-row");
assert.match(await page.getAttribute(".player iframe", "src"), /youtube-nocookie\.com\/embed\/[\w-]{11}/);
assert.deepEqual(await page.locator(".action-row .row-main span:first-child").allTextContents(), ["Save video", "Save audio only", "Save subtitles", "Save thumbnail"]);
await page.click(".action-row");
await page.waitForTimeout(300);
await shot("22-youtube-video-actions");
step("search, results, video page with the tool's actions");

// A real download, from a pasted link.
await page.fill(".ws-search input", SAMPLE);
await page.keyboard.press("Enter");
await page.waitForSelector(".action-row", { timeout: 180000 });
assert.match(await page.textContent(".item-title"), /test-clip/i);
await page.click(".action-row");
await page.click('.action-form:not([hidden]) .choices button:has-text("360p")');
await page.click(".action-form:not([hidden]) .btn.primary");
await page.waitForSelector(".job .good, .job .bad", { timeout: 300000 });
console.log("   job:", (await page.textContent(".job .good, .job .bad")).trim());
assert.equal(await page.locator(".job .good").count(), 1, await page.textContent(".job"));
const saved = await page.locator(".job-results .file-row .row-main span:first-child").allTextContents();
console.log("   file made:", saved);
assert.equal(saved.length, 1);
await page.waitForTimeout(300);
await shot("23-download-done");
const [download] = await Promise.all([page.waitForEvent("download", { timeout: 120000 }), page.click(".job-results .btn")]);
const file = await download.path();
const size = fs.statSync(file).size;
const guest = await sh(`stat -c %s "/root/Files/${saved[0]}"`);
console.log("   saved to phone:", download.suggestedFilename(), size, "bytes");
assert.equal(size, Number(guest.text.trim()));
assert.equal(Buffer.compare(fs.readFileSync(file), clip), 0, "the file saved to the phone is byte-identical");
step("download in Linux, then save the file to the phone");
await page.click(".ws-head .icon-btn");

// ---------------------------------------------------------------- ffmpeg: upload and edit
await install("https://github.com/FFmpeg/FFmpeg");
await page.click(".sheet.full .btn.primary");
await page.waitForSelector(".workspace .upload");
assert.match(await page.textContent(".ws-title"), /Video and audio editor/);
await page.setInputFiles(".workspace .upload input[type=file]", { name: "my holiday clip.mp4", mimeType: "video/mp4", buffer: clip });
await page.waitForSelector(".picked", { timeout: 120000 });
await page.waitForFunction(() => /×/.test(document.querySelector(".picked .muted")?.textContent || ""), null, { timeout: 60000 });
console.log("   uploaded:", (await page.textContent(".picked")).replace(/\s+/g, " ").trim());
await page.click('.action-row:has-text("Trim")');
await page.fill('.action-form:not([hidden]) input >> nth=0', "0:00");
await page.fill('.action-form:not([hidden]) input >> nth=1', "0:01");
await page.waitForTimeout(300);
await shot("24-editor-trim");
await page.click(".action-form:not([hidden]) .btn.primary");
await page.waitForSelector(".job .good, .job .bad", { timeout: 300000 });
assert.equal(await page.locator(".job .good").count(), 1, await page.textContent(".job"));
const trimmed = (await page.locator(".job-results .file-row .row-main span:first-child").allTextContents())[0];
const probe = await sh(`ffprobe -v error -show_entries format=duration -of csv=p=0 "/root/Files/${trimmed}"`);
console.log("   trimmed file:", trimmed, "duration", probe.text.trim(), "s");
assert.ok(Number(probe.text) > 0.4 && Number(probe.text) < 1.6);
await page.click('.action-row:has-text("Extract the sound")');
await page.waitForTimeout(200);
await shot("25-editor-result");
step("upload a video from the phone and trim it");
await page.click(".ws-head .icon-btn");

// ---------------------------------------------------------------- ripgrep: screen built from --help
await install("BurntSushi/ripgrep");
await page.click(".sheet.full .btn.primary");
await page.click('.segmented button:has-text("Files")');
await page.setInputFiles(".workspace .upload input[type=file]", { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("Hello world\nnothing here\nhello again\n") });
await page.waitForSelector('.file-row:has-text("notes.txt")', { timeout: 60000 });
await shot("26-files");
await page.click('.segmented button:has-text("Use")');
await page.waitForSelector(".row.option", { timeout: 60000 });
const optionCount = await page.textContent(".ws-search input[type=search] >> xpath=..").catch(() => "");
console.log("   options listed:", await page.getAttribute('.ws-body input[type=search]', "placeholder"));
await page.fill('.ws-body input[type=search]', "ignore-case");
await page.click('.row.option:has-text("--ignore-case") .switch');
await page.fill('.ws-body .rows input[type=text] >> nth=0', "hello");
await page.click('.ws-body .rows button.row:has-text("File")');
await page.click('.ws-pick .file-row:has-text("notes.txt") .btn');
await page.waitForTimeout(300);
await shot("27-auto-options");
await page.click('.ws-body > .btn.primary');
await page.waitForSelector(".job .good, .job .bad", { timeout: 120000 });
const out = await page.textContent(".job .job-output");
console.log("   rg output:", JSON.stringify(out.trim()));
assert.match(out, /Hello world/);
assert.match(out, /hello again/);
assert.doesNotMatch(out, /nothing here/);
await shot("28-auto-run");
step("options screen generated from the tool's own help, run on an uploaded file");

// ---------------------------------------------------------------- Ask AI (mock API)
await page.click('.segmented button:has-text("Ask AI")');
await page.fill('.ws-body input[type=password]', ai.key);
await shot("29-ask-ai-setup");
await page.click('.ws-body .btn.primary');
await page.fill(".chat-bar textarea", "How many lines in my notes say hello?");
await page.click(".chat-bar .addbar-go");
await page.waitForSelector('.bubble.ai:has-text("2 lines")', { timeout: 120000 });
assert.deepEqual(await page.locator(".cmd code").allTextContents(), ["ls /root/Files", "rg -ci hello /root/Files/notes.txt"]);
const results = ai.requests[2].body.messages.filter(m => Array.isArray(m.content) && m.content[0].type === "tool_result").map(m => m.content[0].content);
console.log("   command results sent to the AI:", JSON.stringify(results));
assert.match(results[0], /notes\.txt/);
assert.equal(results[1].trim(), "2");
assert.match(ai.requests[0].body.system, /ripgrep/);
await page.click(".cmd-head >> nth=1");
await page.waitForTimeout(300);
await shot("30-ask-ai");
step("Ask AI runs commands in Linux and answers");

console.log("errors:", t.errors);
await t.close();
ai.close();
media.close();
process.exit(0);
