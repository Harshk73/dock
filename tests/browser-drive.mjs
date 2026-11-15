// Google Drive backup and restore, against tests/mock-google.mjs.
import assert from "node:assert/strict";
import { chromium, devices } from "playwright";
import { serve } from "./serve.mjs";
import { startMockGoogle } from "./mock-google.mjs";
import { SHOTS } from "./browser-lib.mjs";

const google = await startMockGoogle();
const server = await serve();
const browser = await chromium.launch();

async function phone(label) {
  const context = await browser.newContext({ ...devices["iPhone 14"], deviceScaleFactor: 1 });
  await context.addInitScript(endpoints => localStorage.setItem("dock.dev.google", JSON.stringify(endpoints)), google.endpoints);
  const page = await context.newPage();
  page.on("pageerror", e => console.log(`[${label}] pageerror`, e.message));
  const ready = () => page.waitForSelector('#vm-pill[data-state="ready"]', { timeout: 300000 });
  const sh = script => page.evaluate(s => window.dock.state.vm.machine.agent.capture(s), script);
  const connect = async () => {
    await page.click('.tab[data-view="settings"]');
    await page.fill('input[placeholder*="googleusercontent"]', "test-client.apps.googleusercontent.com");
    await page.keyboard.press("Tab");
    await page.waitForTimeout(400);
    await Promise.all([page.waitForURL(u => !u.hash, { timeout: 30000 }), page.click("text=Connect Google Drive")]);
    await page.waitForSelector("text=Google Drive connected", { timeout: 30000 });
  };
  const backup = async () => {
    await page.click('.tab[data-view="settings"]');
    await page.click("text=Back up now");
  };
  return { context, page, ready, sh, connect, backup };
}

const generation = async n => {
  for (let i = 0; i < 600; i++) {
    const m = google.manifest();
    if (m && m.generation === n) return;
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error("backup generation " + n + " never arrived");
};
const toastsGone = page => page.waitForFunction(() => !document.querySelector(".toast"), null, { timeout: 15000 });

// ---- phone A: connect, write data, back up
const a = await phone("A");
await a.page.goto(server.url);
await a.connect();
assert.equal(new URL(a.page.url()).hash, "", "token removed from the address bar");
await a.ready();
await a.sh("echo first-backup > /root/note.txt; head -c 3000000 /dev/urandom > /root/blob.bin; md5sum /root/blob.bin > /root/blob.md5");
await a.page.evaluate(() => window.dock.state.apps.push({ id: "demo--tool", owner: "demo", repo: "tool", name: "tool", kind: "cli", runtime: "python", status: "installed", addedAt: 1 }));
await a.page.evaluate(async () => { const db = await new Promise(r => { const q = indexedDB.open("dock"); q.onsuccess = () => r(q.result); }); const tx = db.transaction("apps", "readwrite"); tx.objectStore("apps").put(window.dock.state.apps[0]); await new Promise(r => { tx.oncomplete = r; }); });
await a.backup();
await generation(1);
let manifest = google.manifest();
const firstCount = Object.keys(manifest.chunks).length;
console.log(`backup 1: generation ${manifest.generation}, ${firstCount} chunks, ${google.chunkFiles().length} files in Drive`);
assert.equal(manifest.generation, 1);
assert.ok(firstCount >= 4, "the 3 MB blob alone needs at least 3 chunks");
assert.equal(google.chunkFiles().length, firstCount);
assert.equal(manifest.apps.length, 1);
await a.page.waitForTimeout(600);
await a.page.screenshot({ path: `${SHOTS}/13-settings-drive.png` });

// ---- incremental: only changed chunks go up, replaced files are removed
await a.sh("echo second-backup > /root/note.txt");
const before = google.log.filter(l => l.startsWith("POST /upload")).length;
await a.backup();
await generation(2);
manifest = google.manifest();
const uploaded = google.log.filter(l => l.startsWith("POST /upload")).length - before;
console.log(`backup 2: generation ${manifest.generation}, uploaded ${uploaded} chunks, ${google.chunkFiles().length} files in Drive`);
assert.equal(manifest.generation, 2);
assert.ok(uploaded > 0 && uploaded < firstCount, "incremental upload");
assert.equal(google.chunkFiles().length, Object.keys(manifest.chunks).length, "no orphaned chunk files");
await toastsGone(a.page);
await a.backup();
await a.page.waitForSelector("text=Already up to date", { timeout: 60000 });
assert.equal(google.manifest().generation, 3, "an empty backup still records a generation");

// ---- phone B: empty phone restores from Drive
const b = await phone("B");
await b.page.goto(server.url);
await b.connect();
await b.page.click('.tab[data-view="settings"]');
await b.page.click("text=Restore from Drive");
await b.page.click(".sheet-backdrop:last-child .btn.danger");
await b.page.waitForSelector('#vm-pill[data-state="booting"], #vm-pill[data-state="ready"]', { timeout: 120000 });
await b.page.waitForFunction(() => window.dock && window.dock.state.apps.length === 1, null, { timeout: 120000 });
await b.ready();
const r = await b.sh("cat /root/note.txt; md5sum -c /root/blob.md5; dmesg | grep -i 'ext4' | tail -3");
console.log("restored phone:", r.text.trim().replace(/\n/g, " | "));
assert.match(r.text, /second-backup/);
assert.match(r.text, /blob\.bin: OK/);
assert.equal(await b.page.locator(".tile").count(), 1, "app list restored");

// ---- B backs up (same lineage), then A is stale and must be asked before replacing
await b.sh("echo from-phone-b > /root/note.txt");
await b.backup();
await generation(4);
await a.sh("echo from-phone-a > /root/note.txt");
await a.backup();
await a.page.waitForSelector("text=Replace the backup in Drive?", { timeout: 60000 });
await a.page.screenshot({ path: `${SHOTS}/14-backup-conflict.png` });
await a.page.click(".sheet-backdrop:last-child .btn.danger");
await generation(5);
manifest = google.manifest();
// Superseded chunk files are deleted right after the manifest is replaced.
for (let i = 0; i < 100 && google.chunkFiles().length !== Object.keys(manifest.chunks).length; i++) await new Promise(r => setTimeout(r, 300));
console.log(`after replace: generation ${manifest.generation}, ${Object.keys(manifest.chunks).length} chunks, ${google.chunkFiles().length} files`);
assert.equal(google.chunkFiles().length, Object.keys(manifest.chunks).length);

// ---- a revoked or expired token is noticed and the app asks to reconnect
await a.page.evaluate(() => { window.dock.drive.token.accessToken = "revoked"; });
await a.page.click('.tab[data-view="dock"]');
await a.page.click('.tab[data-view="settings"]');
await a.page.waitForSelector("text=Reconnect Google Drive", { timeout: 30000 });
await a.page.waitForSelector("text=Session expired", { timeout: 10000 });
await a.page.click('.tab[data-view="dock"]');
assert.match(await a.page.textContent("#storage-sub"), /needs reconnecting/);
console.log("ALL OK");
await browser.close();
server.close();
google.close();
process.exit(0);
