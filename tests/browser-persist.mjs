// Installs a tool, reloads the page (a cold boot), and checks the tool is still there.
// Also exercises the in-VM web preview and uninstall.
import assert from "node:assert/strict";
import { launch } from "./browser-lib.mjs";

const t = await launch();
const { page, shot } = t;
const sh = script => page.evaluate(s => window.dock.state.vm.machine.agent.capture(s), script);
await page.goto(t.server.url);
await t.ready();
await t.trustSandboxCa();

// 1. install ripgrep (quick: a prebuilt Alpine package)
await page.click("#suggestions .chip:nth-child(3)");
await page.waitForSelector("#install-go", { timeout: 60000 });
await page.click("#install-go");
await page.waitForFunction(() => /is ready|Install failed/.test(document.querySelector(".sheet.full h2")?.textContent || ""), null, { timeout: 600000 });
assert.match(await page.textContent(".sheet.full h2"), /is ready/);
await page.click(".sheet.full .btn:not(.primary)");
let r = await sh("rg --version | head -1; echo marker-$((40+2)) > /root/keep.txt");
assert.match(r.text, /ripgrep \d/);
const app = await page.evaluate(() => window.dock.state.apps[0]);
console.log("installed:", app.name, "commands:", app.bins, "launch:", app.launch);
assert.deepEqual(app.bins, ["rg"]);
assert.equal(app.launch, "rg");
// let the autosave run (guest writeback + 3 s flush)
await page.evaluate(() => window.dock.state.vm.machine.save());
const stored = await page.evaluate(async () => (await indexedDB.databases()).map(d => d.name));
console.log("databases:", stored);

// 2. reload = cold boot from the stored disk
await page.reload();
assert.equal(await page.locator(".tile").count(), 1, "app tile is shown before Linux is up");
const t0 = Date.now();
await t.ready();
console.log("second boot:", Date.now() - t0, "ms");
r = await sh("rg --version | head -1; cat /root/keep.txt; dmesg | grep -ci 'ext4.*error\\|recovery' ");
console.log(r.text.trim());
assert.match(r.text, /ripgrep \d/);
assert.match(r.text, /marker-42/);

// 3. web preview through the service worker
await page.evaluate(() => navigator.serviceWorker.ready);
await sh(`mkdir -p /tmp/site/static && cd /tmp/site && cat > index.html <<'EOT'
<!doctype html><title>Preview</title><link rel="stylesheet" href="/static/site.css">
<h1 id="hello">Hello from inside Linux</h1><a id="next" href="/page2.html">next</a>
<script>fetch("/static/data.json").then(r => r.json()).then(d => { document.body.dataset.loaded = d.value; });</script>
EOT
echo 'h1 { color: rgb(1, 2, 3); }' > static/site.css; echo '{"value": "json-ok"}' > static/data.json
echo '<h1 id="two">Second page</h1>' > page2.html`);
await page.evaluate(() => { window.dock.state.vm.machine.agent.open({ script: "cd /tmp/site && python3 -m http.server 8000 --bind 127.0.0.1" }); });
await page.waitForTimeout(8000);
await page.evaluate(() => window.dock.openPreview({ name: "Demo site", port: 8000 }));
const frame = page.frameLocator(".preview iframe");
await frame.locator("#hello").waitFor({ timeout: 60000 });
await page.waitForFunction(() => document.querySelector(".preview iframe").contentDocument.body.dataset.loaded === "json-ok", null, { timeout: 30000 });
const color = await frame.locator("#hello").evaluate(el => getComputedStyle(el).color);
assert.equal(color, "rgb(1, 2, 3)", "absolute-path stylesheet was served from the VM");
await shot("12-preview");
await frame.locator("#next").click();
await frame.locator("#two").waitFor({ timeout: 30000 });
console.log("preview ok (page, absolute css, fetch, navigation)");
await page.click(".preview .icon-btn");

// 4. uninstall
await page.click(".tile");
await page.click(".sheet .btn.danger");
await page.waitForTimeout(500);
await page.click(".sheet-backdrop:last-child .btn.danger");
await page.waitForFunction(() => document.querySelectorAll(".tile").length === 0, null, { timeout: 60000 });
r = await sh("command -v rg || echo gone; ls /dock/apps | wc -l");
assert.match(r.text, /gone\n0/);
console.log("uninstall ok");
console.log("errors:", t.errors);
await t.close();
process.exit(0);
